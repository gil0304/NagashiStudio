import * as THREE from 'three'
import { Course, PartInstance, WorldChannel } from '../course/course'
import { BAMBOO_R_IN, BOWL_R, BOWL_H } from '../parts/geometry'

const G = 9.81
const STEP = 1 / 120

// ---------------------------------------------------------------------------
// particle core
// ---------------------------------------------------------------------------

interface Particle {
  x: number; y: number; z: number
  px: number; py: number; pz: number
  wc: WorldChannel | null
  s: number
  free: boolean
  restTime: number
}

function makeParticle(x: number, y: number, z: number, wc: WorldChannel | null, s: number): Particle {
  return { x, y, z, px: x, py: y, pz: z, wc, s, free: wc === null, restTime: 0 }
}

const _c = new THREE.Vector3()
const _t = new THREE.Vector3()
const _pv = new THREE.Vector3()

interface ItemPhys {
  radius: number
  buoyancy: number // gravity multiplier when submerged (>1 floats)
  drag: number // velocity blend toward water velocity per step
  bounce: number
}

/**
 * One fixed sub-step of channel-constrained verlet motion.
 * Returns splash intensity if the particle just plunged into water/ground.
 */
function stepParticle(p: Particle, phys: ItemPhys, course: Course, pickBranch: (part: PartInstance) => number, bowls: PartInstance[]): number {
  let splash = 0

  // re-resolve the channel reference: course.touch() rebuilds worldChannels on
  // every edit, and the part itself may have been deleted / reloaded
  if (p.wc && !p.free) {
    const livePart = course.parts.get(p.wc.part.id)
    if (livePart !== p.wc.part || !livePart) {
      p.wc = null
      p.free = true
    } else {
      const fresh = livePart.worldChannels[p.wc.index]
      if (!fresh) {
        p.wc = null
        p.free = true
      } else if (fresh !== p.wc) {
        p.wc = fresh
        p.s = fresh.ch.projectNear(_pv.set(p.x, p.y, p.z), p.s)
      }
    }
  }

  const vx = p.x - p.px
  const vy = p.y - p.py
  const vz = p.z - p.pz

  // water context
  let submerged = false
  let wvx = 0, wvy = 0, wvz = 0
  let inWater = false
  if (p.wc && !p.free) {
    const f = p.wc.flow
    p.s = p.wc.ch.projectNear(_pv.set(p.x, p.y, p.z), p.s)
    p.wc.ch.posAt(p.s, _c)
    p.wc.ch.tanAt(p.s, _t)
    inWater = f.depth > 0.003 && p.s <= f.front
    const surfY = _c.y - BAMBOO_R_IN + f.depth
    submerged = inWater && p.y < surfY + phys.radius * 0.6
    if (submerged) {
      wvx = _t.x * f.v; wvy = _t.y * f.v; wvz = _t.z * f.v
    }
  }

  // integrate
  const damp = p.free ? 0.999 : submerged ? 0.99 : 0.997
  const gMul = submerged ? 1 - phys.buoyancy : 1
  let nvx = vx * damp
  let nvy = vy * damp + gMul * -G * STEP * STEP
  let nvz = vz * damp
  if (submerged) {
    const k = phys.drag
    nvx += (wvx * STEP - nvx) * k
    nvy += (wvy * STEP - nvy) * k * 0.4
    nvz += (wvz * STEP - nvz) * k
  }
  p.px = p.x; p.py = p.y; p.pz = p.z
  p.x += nvx; p.y += nvy; p.z += nvz

  // channel containment
  if (p.wc && !p.free) {
    const ch = p.wc.ch
    p.s = ch.projectNear(_pv.set(p.x, p.y, p.z), p.s)

    // hand off / open-end
    if (p.s >= ch.length - 0.015) {
      const next = course.nextChannel(p.wc, pickBranch)
      if (next) {
        p.wc = next
        p.s = next.ch.projectNear(_pv.set(p.x, p.y, p.z), 0, 0.6)
      } else {
        // beyond the open end -> free fall
        ch.tanAt(ch.length, _t)
        const end = ch.points[ch.points.length - 1]
        const past = (p.x - end.x) * _t.x + (p.y - end.y) * _t.y + (p.z - end.z) * _t.z
        if (past > 0.01) { p.free = true; p.wc = null }
      }
    }

    if (p.wc && !p.free) {
      const chNow = p.wc.ch
      chNow.posAt(p.s, _c)
      chNow.tanAt(p.s, _t)
      let dx = p.x - _c.x
      let dy = p.y - _c.y
      let dz = p.z - _c.z
      const along = dx * _t.x + dy * _t.y + dz * _t.z
      dx -= _t.x * along; dy -= _t.y * along; dz -= _t.z * along
      const len = Math.hypot(dx, dy, dz)
      const maxR = BAMBOO_R_IN - phys.radius * 0.8
      if (len > maxR) {
        const opening = dy > 0.15 * len // roughly upward: half-pipe is open on top
        if (!opening) {
          const kfix = maxR / len
          const fx = _c.x + _t.x * along + dx * kfix
          const fy = _c.y + _t.y * along + dy * kfix
          const fz = _c.z + _t.z * along + dz * kfix
          const push = Math.hypot(p.x - fx, p.y - fy, p.z - fz)
          if (push > 0.02 && inWater) splash = Math.min(1, push * 10)
          p.x = fx; p.y = fy; p.z = fz
          // contact friction: bleed velocity when grounded in a dry/slow trough
          const fric = inWater ? 0.996 : 0.9
          p.px = p.x - (p.x - p.px) * fric
          p.py = p.y - (p.y - p.py) * fric
          p.pz = p.z - (p.z - p.pz) * fric
        }
      }
    }
  } else {
    // free physics: ground + bowls
    if (p.y < phys.radius) {
      const impact = -(p.y - p.py)
      p.y = phys.radius
      p.py = p.y + (p.y - p.py) * phys.bounce
      p.px = p.x - (p.x - p.px) * 0.75
      p.pz = p.z - (p.z - p.pz) * 0.75
      if (impact > 0.004) splash = Math.min(1, impact * 25)
    }
    for (const b of bowls) {
      const bx = b.pos.x
      const bz = b.pos.z
      const dx = p.x - bx
      const dz = p.z - bz
      const hd = Math.hypot(dx, dz)
      const rimY = b.pos.y + BOWL_H
      if (hd < BOWL_R && p.y < rimY) {
        // inside bowl: floor + wall + heavy damping (water bath)
        const floorY = b.pos.y + 0.045 + phys.radius
        const wallR = BOWL_R * 0.78 - phys.radius
        if (p.y < floorY) {
          const impact = -(p.y - p.py)
          if (impact > 0.005) splash = Math.min(1, impact * 30)
          p.y = floorY
          p.py = p.y + (p.y - p.py) * 0.2
        }
        if (hd > wallR && hd > 1e-5) {
          const k = wallR / hd
          p.x = bx + dx * k
          p.z = bz + dz * k
        }
        // water damping
        p.px = p.x - (p.x - p.px) * 0.9
        p.py = p.y - (p.y - p.py) * 0.94
        p.pz = p.z - (p.z - p.pz) * 0.9
      }
    }
  }

  // rest detection
  const sp = Math.hypot(p.x - p.px, p.y - p.py, p.z - p.pz) / STEP
  p.restTime = sp < 0.02 ? p.restTime + STEP : 0
  return splash
}

// ---------------------------------------------------------------------------
// tube mesh for a noodle strand
// ---------------------------------------------------------------------------

const RADIAL = 5

class TubeMesh {
  geo: THREE.BufferGeometry
  mesh: THREE.Mesh
  private n: number
  private pos: Float32Array
  private nor: Float32Array
  private radius: number

  constructor(nCenters: number, radius: number, material: THREE.Material) {
    this.n = nCenters
    this.radius = radius
    this.pos = new Float32Array(nCenters * RADIAL * 3)
    this.nor = new Float32Array(nCenters * RADIAL * 3)
    const idx: number[] = []
    for (let i = 0; i < nCenters - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * RADIAL + j
        const b = i * RADIAL + ((j + 1) % RADIAL)
        const c = a + RADIAL
        const d = b + RADIAL
        idx.push(a, c, b, b, c, d)
      }
    }
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3))
    this.geo.setIndex(idx)
    this.mesh = new THREE.Mesh(this.geo, material)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = true
  }

  update(particles: Particle[]): void {
    const n = this.n
    // parallel-transport frames
    let nx = 1, ny = 0, nz = 0
    for (let i = 0; i < n; i++) {
      const p = particles[i]
      const p0 = particles[Math.max(0, i - 1)]
      const p1 = particles[Math.min(n - 1, i + 1)]
      let tx = p1.x - p0.x, ty = p1.y - p0.y, tz = p1.z - p0.z
      const tl = Math.hypot(tx, ty, tz) || 1
      tx /= tl; ty /= tl; tz /= tl
      // remove tangent component from normal
      const dot = nx * tx + ny * ty + nz * tz
      nx -= tx * dot; ny -= ty * dot; nz -= tz * dot
      let nl = Math.hypot(nx, ny, nz)
      if (nl < 1e-4) { nx = -ty; ny = tx; nz = 0; nl = Math.hypot(nx, ny, nz) || 1 }
      nx /= nl; ny /= nl; nz /= nl
      // binormal
      const bx = ty * nz - tz * ny
      const by = tz * nx - tx * nz
      const bz = tx * ny - ty * nx
      const r = this.radius * (i === 0 || i === n - 1 ? 0.55 : 1)
      for (let j = 0; j < RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const ox = nx * ca + bx * sa
        const oy = ny * ca + by * sa
        const oz = nz * ca + bz * sa
        const k = (i * RADIAL + j) * 3
        this.pos[k] = p.x + ox * r
        this.pos[k + 1] = p.y + oy * r
        this.pos[k + 2] = p.z + oz * r
        this.nor[k] = ox; this.nor[k + 1] = oy; this.nor[k + 2] = oz
      }
    }
    ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.attributes.normal as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
  }
}

// ---------------------------------------------------------------------------
// strands & foods
// ---------------------------------------------------------------------------

const SOMEN_PHYS: ItemPhys = { radius: 0.0035, buoyancy: 1.45, drag: 0.3, bounce: 0.05 }
const N_PARTICLES = 13
const SEG_LEN = 0.022

const somenMat = new THREE.MeshStandardMaterial({ color: 0xfdf6e8, roughness: 0.24, metalness: 0 })

export class Strand {
  particles: Particle[] = []
  tube: TubeMesh
  mat: THREE.MeshStandardMaterial
  choices = new Map<string, number>()
  age = 0
  fade = 1
  dead = false

  constructor(wc: WorldChannel, lateral: number, sStart: number) {
    this.mat = somenMat.clone()
    this.mat.transparent = true
    for (let i = 0; i < N_PARTICLES; i++) {
      const s = Math.max(0.01, sStart - i * SEG_LEN)
      wc.ch.posAt(s, _c)
      wc.ch.tanAt(s, _t)
      // sideways offset within the trough
      const sx = -_t.z, sz = _t.x
      const jitter = (Math.random() - 0.5) * 0.004
      this.particles.push(makeParticle(
        _c.x + sx * (lateral + jitter),
        _c.y - BAMBOO_R_IN + 0.012 + Math.random() * 0.004,
        _c.z + sz * (lateral + jitter),
        wc, s,
      ))
    }
    this.tube = new TubeMesh(N_PARTICLES, SOMEN_PHYS.radius, this.mat)
  }

  pickBranch = (part: PartInstance): number => {
    let c = this.choices.get(part.id)
    if (c === undefined) {
      c = Math.random() < 0.5 ? 0 : 1
      this.choices.set(part.id, c)
    }
    return c
  }

  step(course: Course, bowls: PartInstance[]): number {
    this.age += STEP
    let splash = 0
    for (const p of this.particles) {
      splash = Math.max(splash, stepParticle(p, SOMEN_PHYS, course, this.pickBranch, bowls))
    }
    // distance + gentle bending constraints
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < this.particles.length - 1; i++) {
        const a = this.particles[i]
        const b = this.particles[i + 1]
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
        const d = Math.hypot(dx, dy, dz) || 1e-6
        const diff = (d - SEG_LEN) / d * 0.5
        dx *= diff; dy *= diff; dz *= diff
        a.x += dx; a.y += dy; a.z += dz
        b.x -= dx; b.y -= dy; b.z -= dz
      }
      // bending: keep i..i+2 from folding (smooth, noodle-like curves)
      const rest2 = SEG_LEN * 1.94
      for (let i = 0; i < this.particles.length - 2; i++) {
        const a = this.particles[i]
        const b = this.particles[i + 2]
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
        const d = Math.hypot(dx, dy, dz) || 1e-6
        if (d < rest2) {
          const diff = ((d - rest2) / d) * 0.5 * 0.35
          dx *= diff; dy *= diff; dz *= diff
          a.x += dx; a.y += dy; a.z += dz
          b.x -= dx; b.y -= dy; b.z -= dz
        }
      }
    }
    return splash
  }

  centroid(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0)
    for (const p of this.particles) { out.x += p.x; out.y += p.y; out.z += p.z }
    return out.multiplyScalar(1 / this.particles.length)
  }

  allResting(): boolean {
    return this.particles.every((p) => p.restTime > 18)
  }
}

// ---------------------------------------------------------------------------

export type FoodKind = 'tomato' | 'ice' | 'mikan'

const FOOD_PHYS: Record<FoodKind, ItemPhys> = {
  tomato: { radius: 0.023, buoyancy: 1.04, drag: 0.12, bounce: 0.35 },
  ice: { radius: 0.024, buoyancy: 1.35, drag: 0.2, bounce: 0.2 },
  mikan: { radius: 0.028, buoyancy: 1.06, drag: 0.1, bounce: 0.3 },
}

function buildFoodMesh(kind: FoodKind): THREE.Object3D {
  if (kind === 'tomato') {
    const g = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.023, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xd92e1c, roughness: 0.22 }),
    )
    body.scale.y = 0.92
    const calyx = new THREE.Mesh(
      new THREE.ConeGeometry(0.008, 0.007, 5),
      new THREE.MeshStandardMaterial({ color: 0x3f7a2e, roughness: 0.7 }),
    )
    calyx.position.y = 0.022
    g.add(body, calyx)
    body.castShadow = true
    return g
  }
  if (kind === 'ice') {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.042, 0.042, 0.042),
      new THREE.MeshPhysicalMaterial({
        color: 0xdff2fb, roughness: 0.06, metalness: 0,
        transparent: true, opacity: 0.55, clearcoat: 1,
      }),
    )
    m.castShadow = true
    return m
  }
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.028, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xf59a23, roughness: 0.45 }),
  )
  m.scale.y = 0.85
  m.castShadow = true
  return m
}

export class Food {
  p: Particle
  kind: FoodKind
  phys: ItemPhys
  obj: THREE.Object3D
  spin = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5))
  age = 0
  fade = 1
  dead = false
  meltScale = 1

  constructor(wc: WorldChannel, kind: FoodKind) {
    this.kind = kind
    this.phys = { ...FOOD_PHYS[kind] }
    const s = 0.08
    wc.ch.posAt(s, _c)
    this.p = makeParticle(_c.x, _c.y - BAMBOO_R_IN + this.phys.radius + 0.03, _c.z, wc, s)
    this.obj = buildFoodMesh(kind)
  }

  pickBranch = (part: PartInstance): number => (part.id.charCodeAt(2) + this.kind.length) % 2

  step(course: Course, bowls: PartInstance[]): number {
    this.age += STEP
    const splash = stepParticle(this.p, this.phys, course, this.pickBranch, bowls)
    if (this.kind === 'ice') {
      this.meltScale = Math.max(0.25, 1 - this.age / 75)
      this.phys.radius = FOOD_PHYS.ice.radius * this.meltScale
    }
    return splash
  }

  sync(): void {
    this.obj.position.set(this.p.x, this.p.y, this.p.z)
    const vx = this.p.x - this.p.px
    const vz = this.p.z - this.p.pz
    const speed = Math.hypot(vx, vz)
    const rollRate = speed / Math.max(this.phys.radius, 0.005)
    this.obj.rotateOnWorldAxis(_axis.set(vz, 0, -vx).normalize(), Math.min(rollRate, 12) * STEP)
    const sc = this.meltScale * this.fade
    this.obj.scale.setScalar(Math.max(sc, 0.01))
  }
}

const _axis = new THREE.Vector3()

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

export class ItemSim {
  strands: Strand[] = []
  foods: Food[] = []
  root = new THREE.Group()
  /** splash events emitted during the last step: [x,y,z,intensity] */
  splashes: number[] = []

  private maxStrands = 24
  private maxFoods = 24

  constructor(scene: THREE.Scene) {
    scene.add(this.root)
  }

  spawnSomen(course: Course): boolean {
    const src = course.sources()[0]
    if (!src || src.worldChannels.length === 0) return false
    const wc = src.worldChannels[0]
    const count = 3 + Math.floor(Math.random() * 2)
    for (let i = 0; i < count; i++) {
      const strand = new Strand(wc, (i - (count - 1) / 2) * 0.008, 0.3 + Math.random() * 0.04)
      this.strands.push(strand)
      this.root.add(strand.tube.mesh)
    }
    while (this.strands.filter((s) => !s.dead).length > this.maxStrands) {
      const oldest = this.strands.find((s) => !s.dead)
      if (!oldest) break
      oldest.dead = true
    }
    return true
  }

  spawnFood(course: Course, kind: FoodKind): boolean {
    const src = course.sources()[0]
    if (!src || src.worldChannels.length === 0) return false
    const food = new Food(src.worldChannels[0], kind)
    this.foods.push(food)
    this.root.add(food.obj)
    if (this.foods.filter((f) => !f.dead).length > this.maxFoods) {
      const oldest = this.foods.find((f) => !f.dead)
      if (oldest) oldest.dead = true
    }
    return true
  }

  step(course: Course): void {
    this.splashes.length = 0
    const bowls = course.bowls()
    for (const s of this.strands) {
      const splash = s.step(course, bowls)
      if (splash > 0.15) {
        s.centroid(_c)
        this.splashes.push(_c.x, _c.y, _c.z, splash)
      }
      if (!s.dead && (s.age > 180 || (s.age > 6 && s.allResting()))) s.dead = true
    }
    for (const f of this.foods) {
      const splash = f.step(course, bowls)
      if (splash > 0.2) this.splashes.push(f.p.x, f.p.y, f.p.z, splash)
      if (!f.dead && (f.age > 240 || (f.age > 6 && f.p.restTime > 25) || (f.kind === 'ice' && f.meltScale <= 0.26))) f.dead = true
    }
  }

  /** per render frame: sync meshes, advance fades, prune */
  sync(dt: number): void {
    for (let i = this.strands.length - 1; i >= 0; i--) {
      const s = this.strands[i]
      if (s.dead) {
        s.fade -= dt / 1.2
        s.mat.opacity = Math.max(s.fade, 0)
        if (s.fade <= 0) {
          this.root.remove(s.tube.mesh)
          s.tube.dispose()
          s.mat.dispose()
          this.strands.splice(i, 1)
          continue
        }
      }
      s.tube.update(s.particles)
    }
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i]
      if (f.dead) {
        f.fade -= dt / 0.8
        if (f.fade <= 0) {
          this.root.remove(f.obj)
          disposeObject(f.obj)
          this.foods.splice(i, 1)
          continue
        }
      }
      f.sync()
    }
  }

  /** newest live strand centroid, for the follow camera */
  followTarget(out: THREE.Vector3): boolean {
    for (let i = this.strands.length - 1; i >= 0; i--) {
      if (!this.strands[i].dead) {
        this.strands[i].centroid(out)
        return true
      }
    }
    for (let i = this.foods.length - 1; i >= 0; i--) {
      if (!this.foods[i].dead) {
        const p = this.foods[i].p
        out.set(p.x, p.y, p.z)
        return true
      }
    }
    return false
  }

  clear(): void {
    for (const s of this.strands) { this.root.remove(s.tube.mesh); s.tube.dispose(); s.mat.dispose() }
    for (const f of this.foods) { this.root.remove(f.obj); disposeObject(f.obj) }
    this.strands.length = 0
    this.foods.length = 0
    this.splashes.length = 0
  }
}

function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.isMesh) {
      m.geometry?.dispose()
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      mats.forEach((mm) => mm?.dispose())
    }
  })
}
