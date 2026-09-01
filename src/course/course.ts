import * as THREE from 'three'
import { Channel, uid } from '../util/math'
import { DEF_BY_ID, PartDef, BuiltPart } from '../parts/defs'
import { buildSupport, MAT, BAMBOO_R_IN, LEG_GEO } from '../parts/geometry'

/** Per-channel hydraulic state, updated by the water sim, read by renderers & item sims. */
export interface FlowState {
  Q: number // m^3/s entering this channel
  v: number // m/s mean velocity
  depth: number // m water depth at trough bottom
  turb: number // 0..1 turbulence
  front: number // filled length from channel start (water leading edge)
  stalled: boolean
}

export interface WorldChannel {
  part: PartInstance
  index: number // channel index within the part (= outlet index)
  ch: Channel // world-space polyline
  slope: number
  flow: FlowState
}

export interface PartInstance {
  id: string
  def: PartDef
  built: BuiltPart
  pos: THREE.Vector3
  yaw: number
  pitch: number
  parent: { part: PartInstance; outlet: number } | null
  children: (PartInstance | null)[] // by outlet index
  worldChannels: WorldChannel[]
  wetness: number
  supports: THREE.Group | null
  bowlFill: number // goal bowls only, 0..1
}

export interface CourseJSON {
  version: number
  parts: Array<{ id: string; def: string; pos: [number, number, number]; yaw: number; pitch: number }>
  links: Array<{ parent: string; outlet: number; child: string }>
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler(0, 0, 0, 'YXZ')
const _v = new THREE.Vector3()

export class Course {
  parts = new Map<string, PartInstance>()
  root = new THREE.Group()
  supportRoot = new THREE.Group()
  /** bumped on every structural/transform change; consumers re-sync */
  revision = 0
  onChange: (() => void) | null = null

  constructor(scene: THREE.Scene) {
    scene.add(this.root, this.supportRoot)
  }

  add(defId: string, pos: THREE.Vector3, yaw: number, pitch?: number, forcedId?: string): PartInstance {
    const def = DEF_BY_ID.get(defId)
    if (!def) throw new Error(`unknown part def: ${defId}`)
    const built = def.build()
    const part: PartInstance = {
      id: forcedId ?? uid('p'),
      def,
      built,
      pos: pos.clone(),
      yaw,
      pitch: pitch ?? def.defaultPitch,
      parent: null,
      children: built.outlets.map(() => null),
      worldChannels: [],
      wetness: 0,
      supports: null,
      bowlFill: 0,
    }
    built.group.rotation.order = 'YXZ'
    built.group.userData.partId = part.id
    this.root.add(built.group)
    this.parts.set(part.id, part)
    this.touch()
    return part
  }

  remove(id: string): void {
    const part = this.parts.get(id)
    if (!part) return
    // children become free roots, keeping their current world transform
    for (let i = 0; i < part.children.length; i++) {
      const child = part.children[i]
      if (child) {
        child.parent = null
        part.children[i] = null
      }
    }
    if (part.parent) {
      part.parent.part.children[part.parent.outlet] = null
      part.parent = null
    }
    this.root.remove(part.built.group)
    if (part.supports) this.supportRoot.remove(part.supports)
    disposeGroup(part.built.group)
    part.built.innerMat?.dispose()
    this.parts.delete(id)
    this.touch()
  }

  connect(parent: PartInstance, outlet: number, child: PartInstance): boolean {
    // both parts must still be live members of this course
    if (this.parts.get(parent.id) !== parent || this.parts.get(child.id) !== child) return false
    if (!child.built.hasInput || child.parent || parent.children[outlet]) return false
    if (parent === child || this.isDescendant(child, parent)) return false
    parent.children[outlet] = child
    child.parent = { part: parent, outlet }
    this.touch()
    return true
  }

  disconnect(child: PartInstance): void {
    if (!child.parent) return
    child.parent.part.children[child.parent.outlet] = null
    child.parent = null
    this.touch()
  }

  private isDescendant(ancestor: PartInstance, candidate: PartInstance): boolean {
    for (const c of ancestor.children) {
      if (!c) continue
      if (c === candidate || this.isDescendant(c, candidate)) return true
    }
    return false
  }

  roots(): PartInstance[] {
    return [...this.parts.values()].filter((p) => !p.parent)
  }

  sources(): PartInstance[] {
    return [...this.parts.values()].filter((p) => p.def.isSource)
  }

  bowls(): PartInstance[] {
    return [...this.parts.values()].filter((p) => p.def.isGoal)
  }

  /** suppresses per-mutation recompute during bulk load/clear */
  private batching = false

  /** Recompute chained transforms, world channels, and support posts. */
  touch(): void {
    if (this.batching) return
    this.revision++
    for (const root of this.roots()) this.applyChain(root)
    this.onChange?.()
  }

  private applyChain(part: PartInstance): void {
    const g = part.built.group
    g.position.copy(part.pos)
    g.rotation.set(part.pitch, part.yaw, 0)
    g.updateMatrixWorld(true)

    // world channels (preserve flow state across rebuilds)
    const prev = part.worldChannels
    part.worldChannels = part.built.channels.map((local, i) => {
      const pts = local.points.map((p) => p.clone().applyMatrix4(g.matrixWorld))
      const ch = new Channel(pts)
      const a = pts[0]
      const b = pts[pts.length - 1]
      const horiz = Math.max(0.01, Math.hypot(b.x - a.x, b.z - a.z))
      const slope = (a.y - b.y) / horiz
      return {
        part,
        index: i,
        ch,
        slope,
        flow: prev[i]?.flow ?? { Q: 0, v: 0, depth: 0, turb: 0, front: 0, stalled: false },
      }
    })

    this.rebuildSupports(part)

    for (let i = 0; i < part.children.length; i++) {
      const child = part.children[i]
      if (!child) continue
      const outlet = part.built.outlets[i]
      child.pos.copy(outlet.pos).applyMatrix4(g.matrixWorld)
      child.yaw = part.yaw + outlet.yawOffset
      this.applyChain(child)
    }
  }

  private rebuildSupports(part: PartInstance): void {
    if (part.supports) {
      this.supportRoot.remove(part.supports)
      disposeGroup(part.supports, true)
      part.supports = null
    }
    const g = new THREE.Group()
    if (part.def.isSource) {
      // tripod legs under the tub
      const tub = _v.set(0, 0, -0.16).applyMatrix4(part.built.group.matrixWorld)
      const legTop = tub.y - 0.1
      if (legTop > 0.1) {
        for (let i = 0; i < 3; i++) {
          const a = part.yaw + (i / 3) * Math.PI * 2 + 0.5
          const leg = new THREE.Mesh(LEG_GEO, MAT.post)
          const base = new THREE.Vector3(tub.x + Math.sin(a) * 0.24, 0, tub.z + Math.cos(a) * 0.24)
          const top = new THREE.Vector3(tub.x + Math.sin(a) * 0.1, legTop + 0.12, tub.z + Math.cos(a) * 0.1)
          const dir = top.clone().sub(base)
          leg.scale.y = dir.length()
          leg.position.copy(base)
          leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
          leg.castShadow = true
          g.add(leg)
        }
      }
    } else if (part.worldChannels.length > 0) {
      // one X-support under each outlet end (and under the input for roots),
      // oriented along the local flow direction
      const spots: Array<{ p: THREE.Vector3; yaw: number }> = []
      for (let i = 0; i < part.worldChannels.length; i++) {
        const wc = part.worldChannels[i]
        spots.push({
          p: wc.ch.points[wc.ch.points.length - 1].clone(),
          yaw: part.yaw + (part.built.outlets[i]?.yawOffset ?? 0),
        })
      }
      if (!part.parent && part.built.hasInput) {
        spots.push({ p: part.worldChannels[0].ch.points[0].clone(), yaw: part.yaw })
      }
      for (const s of spots) {
        g.add(buildSupport(s.p, s.yaw))
      }
    }
    if (g.children.length > 0) {
      part.supports = g
      this.supportRoot.add(g)
    }
  }

  /** Downstream channel a strand enters when leaving `wc`, or null at an open end. */
  nextChannel(wc: WorldChannel, pickBranch: (part: PartInstance) => number): WorldChannel | null {
    const child = wc.part.children[wc.index]
    if (!child || child.worldChannels.length === 0) return null
    const idx = child.worldChannels.length > 1 ? pickBranch(child) : 0
    return child.worldChannels[idx]
  }

  allChannels(): WorldChannel[] {
    const out: WorldChannel[] = []
    for (const p of this.parts.values()) out.push(...p.worldChannels)
    return out
  }

  // ------------------------------------------------------------------
  // serialization
  // ------------------------------------------------------------------

  serialize(): CourseJSON {
    const parts = [...this.parts.values()].map((p) => ({
      id: p.id,
      def: p.def.id,
      pos: [p.pos.x, p.pos.y, p.pos.z] as [number, number, number],
      yaw: p.yaw,
      pitch: p.pitch,
    }))
    const links: CourseJSON['links'] = []
    for (const p of this.parts.values()) {
      p.children.forEach((c, i) => {
        if (c) links.push({ parent: p.id, outlet: i, child: c.id })
      })
    }
    return { version: 1, parts, links }
  }

  load(data: CourseJSON): void {
    this.clear()
    this.batching = true
    try {
      for (const p of data.parts) {
        if (!DEF_BY_ID.has(p.def)) continue
        if (this.parts.has(p.id)) continue // reject duplicate ids from untrusted JSON
        this.add(p.def, new THREE.Vector3(...p.pos), p.yaw, p.pitch, p.id)
      }
      for (const l of data.links) {
        const parent = this.parts.get(l.parent)
        const child = this.parts.get(l.child)
        if (parent && child && l.outlet < parent.children.length) this.connect(parent, l.outlet, child)
      }
    } finally {
      this.batching = false
    }
    this.touch()
  }

  clear(): void {
    this.batching = true
    try {
      for (const id of [...this.parts.keys()]) this.remove(id)
    } finally {
      this.batching = false
    }
    this.touch()
  }
}

function disposeGroup(g: THREE.Object3D, geoOnly = false): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      // shared cached geometries (supports) are not disposed
      if (!geoOnly) mesh.geometry?.dispose()
    }
  })
}
