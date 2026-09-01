import * as THREE from 'three'
import { Course, PartInstance } from '../course/course'
import { DEF_BY_ID, PartDef, BuiltPart } from '../parts/defs'
import { Stage } from '../engine/scene'

const SNAP_DIST = 0.45

interface OpenOutlet {
  part: PartInstance
  outlet: number
  pos: THREE.Vector3
  yaw: number
}

class History {
  private states: string[] = []
  private idx = -1
  private limit = 200

  push(state: string): void {
    if (this.states[this.idx] === state) return
    this.states.length = this.idx + 1
    this.states.push(state)
    if (this.states.length > this.limit) this.states.shift()
    this.idx = this.states.length - 1
  }

  undo(): string | null {
    if (this.idx <= 0) return null
    this.idx--
    return this.states[this.idx]
  }

  redo(): string | null {
    if (this.idx >= this.states.length - 1) return null
    this.idx++
    return this.states[this.idx]
  }

  get canUndo(): boolean { return this.idx > 0 }
  get canRedo(): boolean { return this.idx < this.states.length - 1 }
}

export class Editor {
  course: Course
  stage: Stage
  selected: PartInstance | null = null

  onSelect: (p: PartInstance | null) => void = () => {}
  onPlacingChange: (defId: string | null) => void = () => {}
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void = () => {}
  onEdit: () => void = () => {}
  toast: (msg: string) => void = () => {}

  private history = new History()
  private raycaster = new THREE.Raycaster()
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private ndc = new THREE.Vector2()
  private groundHit = new THREE.Vector3()

  // placement
  private placingDef: PartDef | null = null
  private ghost: BuiltPart | null = null
  private ghostYaw = 0
  private ghostSnap: OpenOutlet | null = null
  private ghostValid = false

  // dragging
  private dragging: PartInstance | null = null
  private dragOffset = new THREE.Vector2()
  private dragSnap: OpenOutlet | null = null
  private downPos = new THREE.Vector2()
  private maybeDrag: PartInstance | null = null
  private moved = false

  // selection visuals
  private savedMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()

  constructor(course: Course, stage: Stage, canvas: HTMLCanvasElement) {
    this.course = course
    this.stage = stage

    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e))
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e))
    canvas.addEventListener('contextmenu', (e) => {
      if (this.placingDef) {
        e.preventDefault()
        this.cancelPlacing()
      }
    })
    window.addEventListener('keydown', (e) => this.onKey(e))
  }

  // ------------------------------------------------------------------
  // history
  // ------------------------------------------------------------------

  snapshot(): void {
    this.history.push(JSON.stringify(this.course.serialize()))
    this.onHistoryChange(this.history.canUndo, this.history.canRedo)
    this.onEdit()
  }

  undo(): void { this.restore(this.history.undo()) }
  redo(): void { this.restore(this.history.redo()) }

  private restore(state: string | null): void {
    if (!state) return
    this.cancelDrag()
    this.select(null)
    this.course.load(JSON.parse(state))
    this.onHistoryChange(this.history.canUndo, this.history.canRedo)
    this.onEdit()
  }

  private cancelDrag(): void {
    this.dragging = null
    this.dragSnap = null
    this.maybeDrag = null
    this.stage.controls.enabled = true
  }

  // ------------------------------------------------------------------
  // placement
  // ------------------------------------------------------------------

  startPlacing(defId: string): void {
    this.cancelPlacing()
    const def = DEF_BY_ID.get(defId)
    if (!def) return
    this.placingDef = def
    this.ghost = def.build()
    this.ghost.group.rotation.order = 'YXZ'
    this.ghost.group.visible = false
    this.ghost.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        m.material = mats.map((mm) => {
          const c = (mm as THREE.MeshStandardMaterial).clone()
          c.transparent = true
          c.opacity = 0.55
          c.depthWrite = false
          return c
        })[0]
        m.castShadow = false
        m.receiveShadow = false
      }
    })
    this.stage.scene.add(this.ghost.group)
    this.select(null)
    this.onPlacingChange(defId)
  }

  cancelPlacing(): void {
    if (this.ghost) {
      this.stage.scene.remove(this.ghost.group)
      this.disposeGhost(this.ghost)
      this.ghost = null
    }
    if (this.placingDef) {
      this.placingDef = null
      this.onPlacingChange(null)
    }
  }

  private disposeGhost(g: BuiltPart): void {
    g.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry?.dispose()
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        mats.forEach((mm) => mm.dispose())
      }
    })
  }

  // ------------------------------------------------------------------
  // selection
  // ------------------------------------------------------------------

  select(part: PartInstance | null): void {
    if (this.selected === part) return
    // restore originals and dispose the highlight clones
    for (const [mesh, mat] of this.savedMats) {
      const current = mesh.material
      mesh.material = mat
      if (current !== mat && !Array.isArray(current)) (current as THREE.Material).dispose()
    }
    this.savedMats.clear()
    this.selected = part
    if (part) {
      part.built.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          this.savedMats.set(m, m.material)
          const mats = Array.isArray(m.material) ? m.material[0] : m.material
          const c = (mats as THREE.MeshStandardMaterial).clone()
          if ('emissive' in c) {
            c.emissive = new THREE.Color(0x2b6e4f)
            c.emissiveIntensity = 0.55
          }
          m.material = c
        }
      })
    }
    this.onSelect(part)
  }

  refreshSelectionVisual(): void {
    const p = this.selected
    if (!p) return
    this.select(null)
    this.select(p)
  }

  // ------------------------------------------------------------------
  // inspector ops
  // ------------------------------------------------------------------

  setPitch(v: number): void {
    if (!this.selected) return
    this.selected.pitch = v
    this.course.touch()
  }

  setHeight(v: number): void {
    if (!this.selected || this.selected.parent) return
    this.selected.pos.y = v
    this.course.touch()
  }

  rotateSelected(delta: number): void {
    if (!this.selected || this.selected.parent) return
    this.selected.yaw += delta
    this.course.touch()
    this.snapshot()
  }

  detachSelected(): void {
    if (!this.selected?.parent) return
    this.course.disconnect(this.selected)
    this.snapshot()
    this.onSelect(this.selected) // refresh inspector
  }

  deleteSelected(): void {
    if (!this.selected) return
    this.cancelDrag()
    const id = this.selected.id
    this.select(null)
    this.course.remove(id)
    this.snapshot()
  }

  // ------------------------------------------------------------------
  // pointer
  // ------------------------------------------------------------------

  private setNdc(e: PointerEvent): void {
    const el = this.stage.renderer.domElement
    const r = el.getBoundingClientRect()
    // fall back to the renderer's logical size when layout is not realized (headless/hidden)
    const pr = this.stage.renderer.getPixelRatio()
    const w = r.width || el.width / pr
    const h = r.height || el.height / pr
    this.ndc.set(((e.clientX - r.left) / w) * 2 - 1, -((e.clientY - r.top) / h) * 2 + 1)
  }

  private castGround(e: PointerEvent): THREE.Vector3 | null {
    this.setNdc(e)
    this.raycaster.setFromCamera(this.ndc, this.stage.camera)
    return this.raycaster.ray.intersectPlane(this.groundPlane, this.groundHit)
  }

  private castPart(e: PointerEvent): PartInstance | null {
    this.setNdc(e)
    this.raycaster.setFromCamera(this.ndc, this.stage.camera)
    const hits = this.raycaster.intersectObjects(this.course.root.children, true)
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object
      while (o) {
        if (o.userData.partId) return this.course.parts.get(o.userData.partId) ?? null
        o = o.parent
      }
    }
    return null
  }

  private openOutlets(exclude?: PartInstance): OpenOutlet[] {
    const out: OpenOutlet[] = []
    for (const p of this.course.parts.values()) {
      if (p === exclude) continue
      if (exclude && this.isInSubtree(exclude, p)) continue
      for (let i = 0; i < p.children.length; i++) {
        if (p.children[i]) continue
        const wc = p.worldChannels[i]
        if (!wc) continue
        out.push({
          part: p,
          outlet: i,
          pos: wc.ch.points[wc.ch.points.length - 1].clone(),
          yaw: p.yaw + p.built.outlets[i].yawOffset,
        })
      }
    }
    return out
  }

  private isInSubtree(root: PartInstance, candidate: PartInstance): boolean {
    if (root === candidate) return true
    for (const c of root.children) {
      if (c && this.isInSubtree(c, candidate)) return true
    }
    return false
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.placingDef && this.ghost) {
      const hit = this.castGround(e)
      if (!hit) return
      this.ghost.group.visible = true
      this.ghostSnap = null
      if (this.ghost.hasInput) {
        let best: OpenOutlet | null = null
        let bestD = SNAP_DIST
        for (const o of this.openOutlets()) {
          const d = Math.hypot(o.pos.x - hit.x, o.pos.z - hit.z)
          if (d < bestD) { bestD = d; best = o }
        }
        this.ghostSnap = best
      }
      if (this.ghostSnap) {
        this.ghost.group.position.copy(this.ghostSnap.pos)
        this.ghost.group.rotation.set(this.placingDef.hasPitch ? this.placingDef.defaultPitch : 0, this.ghostSnap.yaw, 0)
      } else {
        this.ghost.group.position.set(hit.x, this.placingDef.defaultY, hit.z)
        this.ghost.group.rotation.set(this.placingDef.hasPitch ? this.placingDef.defaultPitch : 0, this.ghostYaw, 0)
      }
      this.ghostValid = true
      this.tintGhost(this.ghostSnap ? 0x7fd4a8 : 0xffffff)
      return
    }

    if (this.maybeDrag && !this.dragging) {
      if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 5) {
        this.dragging = this.maybeDrag
        this.stage.controls.enabled = false
        const hit = this.castGround(e)
        if (hit) this.dragOffset.set(this.dragging.pos.x - hit.x, this.dragging.pos.z - hit.z)
      }
    }

    if (this.dragging) {
      const hit = this.castGround(e)
      if (!hit) return
      const p = this.dragging
      p.pos.x = hit.x + this.dragOffset.x
      p.pos.z = hit.z + this.dragOffset.y
      // magnetic snap of the part's input to a nearby open outlet
      this.dragSnap = null
      if (p.built.hasInput && !p.parent) {
        let best: OpenOutlet | null = null
        let bestD = SNAP_DIST * 0.8
        for (const o of this.openOutlets(p)) {
          const d = o.pos.distanceTo(p.pos)
          if (d < bestD) { bestD = d; best = o }
        }
        if (best) {
          p.pos.copy(best.pos)
          p.yaw = best.yaw
          this.dragSnap = best
        }
      }
      this.course.touch()
      this.moved = true
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    this.downPos.set(e.clientX, e.clientY)
    this.moved = false
    if (this.placingDef) return
    const part = this.castPart(e)
    this.maybeDrag = part && !part.parent ? part : null
    if (this.maybeDrag) {
      // keep receiving move/up even if the pointer leaves the canvas mid-drag
      try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* noop */ }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0) return
    const wasDragging = this.dragging
    if (wasDragging) {
      if (this.dragSnap) {
        const ok = this.course.connect(this.dragSnap.part, this.dragSnap.outlet, wasDragging)
        if (ok) {
          this.toast('接続しました')
          if (this.selected === wasDragging) this.onSelect(wasDragging) // refresh inspector rows
        }
      }
      this.cancelDrag()
      if (this.moved) this.snapshot()
      return
    }
    this.maybeDrag = null

    const isClick = Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) < 5
    if (!isClick) return

    if (this.placingDef && this.ghost && this.ghost.group.visible) {
      // commit placement
      const def = this.placingDef
      const pos = this.ghost.group.position.clone()
      const yaw = this.ghost.group.rotation.y
      const part = this.course.add(def.id, pos, yaw)
      if (this.ghostSnap) {
        this.course.connect(this.ghostSnap.part, this.ghostSnap.outlet, part)
      }
      this.course.touch()
      this.snapshot()
      // force the next pointermove to recompute snapping before another commit
      this.ghostSnap = null
      if (this.ghost) this.ghost.group.visible = false
      if (def.isSource || def.isGoal) this.cancelPlacing()
      return
    }

    const part = this.castPart(e)
    this.select(part)
  }

  private tintGhost(color: number): void {
    if (!this.ghost) return
    this.ghost.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const mat = m.material as THREE.MeshStandardMaterial
        if (mat && 'emissive' in mat) {
          mat.emissive.setHex(color === 0xffffff ? 0x000000 : color)
          mat.emissiveIntensity = 0.4
        }
      }
    })
  }

  // ------------------------------------------------------------------
  // keyboard
  // ------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
    if (document.getElementById('help')?.classList.contains('visible')) return // modal open
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (meta && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      this.redo()
      return
    }
    switch (e.key) {
      case 'Escape':
        if (this.placingDef) this.cancelPlacing()
        else this.select(null)
        break
      case 'Delete':
      case 'Backspace':
        this.deleteSelected()
        break
      case 'q':
      case 'Q':
        if (this.placingDef) this.ghostYaw += Math.PI / 12
        else this.rotateSelected(Math.PI / 12)
        break
      case 'e':
      case 'E':
        if (this.placingDef) this.ghostYaw -= Math.PI / 12
        else this.rotateSelected(-Math.PI / 12)
        break
    }
  }
}
