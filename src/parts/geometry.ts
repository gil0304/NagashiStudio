import * as THREE from 'three'
import { Channel } from '../util/math'

// ---------------------------------------------------------------------------
// Shared procedural textures & materials
// ---------------------------------------------------------------------------

function makeCanvas(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  draw(ctx, size)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Fiber striations running along the bamboo length (canvas x = along length). */
const bambooFiberTex = makeCanvas(256, (ctx, s) => {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, s, s)
  for (let y = 0; y < s; y += 2) {
    const tone = 235 + Math.floor(Math.random() * 20)
    ctx.fillStyle = `rgba(${tone - 14},${tone - 6},${tone - 30},${0.35 + Math.random() * 0.3})`
    ctx.fillRect(0, y, s, 1 + Math.random() * 2)
  }
  // sparse darker fiber lines
  for (let i = 0; i < 60; i++) {
    const y = Math.random() * s
    ctx.fillStyle = `rgba(120,110,70,${0.06 + Math.random() * 0.1})`
    ctx.fillRect(Math.random() * s * 0.5, y, s * (0.3 + Math.random() * 0.7), 1)
  }
})

const woodTex = makeCanvas(256, (ctx, s) => {
  ctx.fillStyle = '#b58a5c'
  ctx.fillRect(0, 0, s, s)
  for (let y = 0; y < s; y += 3) {
    const t = 0.5 + 0.5 * Math.sin(y * 0.3 + Math.sin(y * 0.05) * 3)
    ctx.fillStyle = `rgba(90,60,30,${0.08 + t * 0.14})`
    ctx.fillRect(0, y, s, 2)
  }
  for (let i = 0; i < 25; i++) {
    ctx.fillStyle = `rgba(70,45,20,${0.1 + Math.random() * 0.15})`
    ctx.fillRect(0, Math.random() * s, s, 1)
  }
})

const grassTex = makeCanvas(512, (ctx, s) => {
  ctx.fillStyle = '#89a55e'
  ctx.fillRect(0, 0, s, s)
  for (let i = 0; i < 9000; i++) {
    const g = 130 + Math.random() * 60
    ctx.fillStyle = `rgba(${g * 0.62},${g},${g * 0.42},0.5)`
    ctx.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 2 + Math.random() * 3)
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(110,130,70,${0.08 + Math.random() * 0.1})`
    ctx.beginPath()
    ctx.arc(Math.random() * s, Math.random() * s, 20 + Math.random() * 60, 0, 7)
    ctx.fill()
  }
})
grassTex.repeat.set(14, 14)

export const MAT = {
  bambooOuter: new THREE.MeshStandardMaterial({
    color: 0x8fae4e, map: bambooFiberTex, roughness: 0.55, metalness: 0, vertexColors: true,
  }),
  bambooOuterDry: new THREE.MeshStandardMaterial({
    color: 0xc8b578, map: bambooFiberTex, roughness: 0.6, metalness: 0, vertexColors: true,
  }),
  post: new THREE.MeshStandardMaterial({ color: 0xa3b06a, map: bambooFiberTex, roughness: 0.6 }),
  rope: new THREE.MeshStandardMaterial({ color: 0x6b5636, roughness: 0.9 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xb08a5a, map: woodTex, roughness: 0.7 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x7d6142, map: woodTex, roughness: 0.75 }),
  ceramic: new THREE.MeshStandardMaterial({ color: 0x2e5a78, roughness: 0.3, metalness: 0.05 }),
  ceramicIn: new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.4 }),
  grass: new THREE.MeshStandardMaterial({ color: 0xffffff, map: grassTex, roughness: 1 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8d8d86, roughness: 0.9 }),
}

/** Fresh per-part clone of the inner (trough) material so wetness can darken it individually. */
export function makeInnerMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xf3e8c8, map: bambooFiberTex, roughness: 0.55, metalness: 0,
    side: THREE.DoubleSide,
  })
}

export const INNER_DRY = new THREE.Color(0xf3e8c8)
export const INNER_WET = new THREE.Color(0xcbb98a)

// ---------------------------------------------------------------------------
// Bamboo trough extrusion along a channel
// ---------------------------------------------------------------------------

export const BAMBOO_R_IN = 0.05
export const BAMBOO_R_OUT = 0.058
const WALL_ANGLE = (95 * Math.PI) / 180 // half-pipe opening: from -95° to +95° measured from the bottom

const _t = new THREE.Vector3()
const _side = new THREE.Vector3()
const _up = new THREE.Vector3()
const _c = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

interface TroughMeshes {
  outer: THREE.Mesh
  inner: THREE.Mesh
  extras: THREE.Mesh
}

/**
 * Builds outer shell (with node bulges, vertex-color darkened at nodes) and inner
 * trough surface (+ rim strips + end caps) along a channel polyline.
 * Channel points are the CENTER of the pipe circle.
 */
export function buildTrough(channel: Channel, innerMat: THREE.Material, opts?: { nodeEvery?: number; capStart?: boolean; capEnd?: boolean }): TroughMeshes {
  const nodeEvery = opts?.nodeEvery ?? 0.55
  const L = channel.length
  const step = 0.05
  const nRings = Math.max(2, Math.ceil(L / step) + 1)
  const nArc = 14 // radial segments across the half-pipe arc

  const nodePositions: number[] = []
  for (let s = nodeEvery * 0.55; s < L - 0.08; s += nodeEvery) nodePositions.push(s)

  const bulgeAt = (s: number) => {
    let b = 0
    for (const ns of nodePositions) {
      const d = Math.abs(s - ns)
      if (d < 0.045) b = Math.max(b, Math.cos((d / 0.045) * Math.PI * 0.5))
    }
    return b
  }

  // ring frame at arc length s
  const frame = (s: number) => {
    channel.posAt(s, _c)
    channel.tanAt(s, _t)
    _side.crossVectors(UP, _t)
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0)
    _side.normalize()
    _up.crossVectors(_t, _side).normalize()
  }

  const outerPos: number[] = []
  const outerUv: number[] = []
  const outerCol: number[] = []
  const innerPos: number[] = []
  const innerUv: number[] = []

  const ringS: number[] = []
  for (let i = 0; i < nRings; i++) ringS.push((i / (nRings - 1)) * L)

  for (const s of ringS) {
    frame(s)
    const bulge = bulgeAt(s)
    const rOut = BAMBOO_R_OUT * (1 + bulge * 0.07)
    const shade = 1 - bulge * 0.35
    for (let j = 0; j <= nArc; j++) {
      const th = -WALL_ANGLE + (j / nArc) * 2 * WALL_ANGLE
      const sin = Math.sin(th)
      const cos = Math.cos(th)
      // outer
      outerPos.push(
        _c.x + _side.x * sin * rOut - _up.x * cos * rOut,
        _c.y + _side.y * sin * rOut - _up.y * cos * rOut,
        _c.z + _side.z * sin * rOut - _up.z * cos * rOut,
      )
      outerUv.push(s * 2.2, j / nArc)
      outerCol.push(shade, shade, shade)
      // inner
      innerPos.push(
        _c.x + _side.x * sin * BAMBOO_R_IN - _up.x * cos * BAMBOO_R_IN,
        _c.y + _side.y * sin * BAMBOO_R_IN - _up.y * cos * BAMBOO_R_IN,
        _c.z + _side.z * sin * BAMBOO_R_IN - _up.z * cos * BAMBOO_R_IN,
      )
      innerUv.push(s * 2.2, j / nArc)
    }
  }

  const gridIndex = (rings: number, cols: number, flip = false) => {
    const idx: number[] = []
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < cols; j++) {
        const a = i * (cols + 1) + j
        const b = a + cols + 1
        if (!flip) idx.push(a, b, a + 1, a + 1, b, b + 1)
        else idx.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
    return idx
  }

  const outerGeo = new THREE.BufferGeometry()
  outerGeo.setAttribute('position', new THREE.Float32BufferAttribute(outerPos, 3))
  outerGeo.setAttribute('uv', new THREE.Float32BufferAttribute(outerUv, 2))
  outerGeo.setAttribute('color', new THREE.Float32BufferAttribute(outerCol, 3))
  outerGeo.setIndex(gridIndex(nRings, nArc))
  outerGeo.computeVertexNormals()

  const innerGeo = new THREE.BufferGeometry()
  innerGeo.setAttribute('position', new THREE.Float32BufferAttribute(innerPos, 3))
  innerGeo.setAttribute('uv', new THREE.Float32BufferAttribute(innerUv, 2))
  innerGeo.setIndex(gridIndex(nRings, nArc, true))
  innerGeo.computeVertexNormals()

  // rim strips + end caps (annulus between inner and outer radius), assigned to inner material
  const extraPos: number[] = []
  const extraUv: number[] = []
  const extraIdx: number[] = []
  const quad = (p: THREE.Vector3[], flip = false) => {
    const base = extraPos.length / 3
    for (const v of p) {
      extraPos.push(v.x, v.y, v.z)
      extraUv.push(v.x * 2, v.z * 2)
    }
    if (!flip) extraIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    else extraIdx.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
  const ringPoint = (s: number, th: number, rho: number) => {
    frame(s)
    return new THREE.Vector3(
      _c.x + _side.x * Math.sin(th) * rho - _up.x * Math.cos(th) * rho,
      _c.y + _side.y * Math.sin(th) * rho - _up.y * Math.cos(th) * rho,
      _c.z + _side.z * Math.sin(th) * rho - _up.z * Math.cos(th) * rho,
    )
  }
  // rims (top edges of both walls) as long strips
  for (const sign of [-1, 1]) {
    const th = sign * WALL_ANGLE
    for (let i = 0; i < nRings - 1; i++) {
      const s0 = ringS[i]
      const s1 = ringS[i + 1]
      const a = ringPoint(s0, th, BAMBOO_R_IN)
      const b = ringPoint(s0, th, BAMBOO_R_OUT)
      const c2 = ringPoint(s1, th, BAMBOO_R_OUT)
      const d = ringPoint(s1, th, BAMBOO_R_IN)
      quad([a, b, c2, d], sign > 0)
    }
  }
  // end caps
  const caps: Array<[number, boolean]> = []
  if (opts?.capStart !== false) caps.push([0, true])
  if (opts?.capEnd !== false) caps.push([L, false])
  for (const [s, isStart] of caps) {
    for (let j = 0; j < nArc; j++) {
      const th0 = -WALL_ANGLE + (j / nArc) * 2 * WALL_ANGLE
      const th1 = -WALL_ANGLE + ((j + 1) / nArc) * 2 * WALL_ANGLE
      const a = ringPoint(s, th0, BAMBOO_R_IN)
      const b = ringPoint(s, th0, BAMBOO_R_OUT)
      const c2 = ringPoint(s, th1, BAMBOO_R_OUT)
      const d = ringPoint(s, th1, BAMBOO_R_IN)
      quad([a, b, c2, d], !isStart)
    }
  }
  const extraGeo = new THREE.BufferGeometry()
  extraGeo.setAttribute('position', new THREE.Float32BufferAttribute(extraPos, 3))
  extraGeo.setAttribute('uv', new THREE.Float32BufferAttribute(extraUv, 2))
  extraGeo.setIndex(extraIdx)
  extraGeo.computeVertexNormals()

  const outer = new THREE.Mesh(outerGeo, MAT.bambooOuter)
  outer.castShadow = true
  outer.receiveShadow = true

  const innerMesh = new THREE.Mesh(innerGeo, innerMat)
  const extraMesh = new THREE.Mesh(extraGeo, innerMat)
  innerMesh.receiveShadow = true

  return { outer, inner: innerMesh, extras: extraMesh }
}

// ---------------------------------------------------------------------------
// Support posts (auto-generated X crossed sticks)
// ---------------------------------------------------------------------------

const postGeoCache = new THREE.CylinderGeometry(0.013, 0.016, 1, 7)
postGeoCache.translate(0, 0.5, 0)
const bandGeoCache = new THREE.CylinderGeometry(0.019, 0.019, 0.036, 8)
export const LEG_GEO = new THREE.CylinderGeometry(0.016, 0.02, 1, 7)
LEG_GEO.translate(0, 0.5, 0)

/**
 * X-shaped support: two crossed sticks whose upper V cradles a pipe
 * (outer radius ~0.058) centered at height p.y. Faces `yaw` (flow direction).
 */
export function buildSupport(p: THREE.Vector3, yaw: number): THREE.Group {
  const g = new THREE.Group()
  if (p.y < 0.22) return g
  const topY = p.y + 0.14
  const topX = 0.11
  const spread = 0.36 + p.y * 0.18
  for (const sign of [-1, 1]) {
    const stick = new THREE.Mesh(postGeoCache, MAT.post)
    const base = new THREE.Vector3(sign * spread * 0.5, 0, 0)
    const top = new THREE.Vector3(-sign * topX, topY, 0)
    const dir = top.clone().sub(base)
    stick.scale.y = dir.length()
    stick.position.copy(base)
    stick.quaternion.setFromUnitVectors(UP, dir.normalize())
    stick.castShadow = true
    g.add(stick)
  }
  // lashing band at the crossing point (x = 0 on both sticks)
  const tCross = (spread * 0.5) / (spread * 0.5 + topX)
  const band = new THREE.Mesh(bandGeoCache, MAT.rope)
  band.position.set(0, topY * tCross, 0)
  band.rotation.z = 0.5
  g.add(band)
  g.position.set(p.x, 0, p.z)
  g.rotation.y = yaw
  return g
}

// ---------------------------------------------------------------------------
// Bowl (goal)
// ---------------------------------------------------------------------------

export const BOWL_R = 0.21
export const BOWL_H = 0.16

export function buildBowl(): THREE.Group {
  const g = new THREE.Group()
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.001, 0.012),
    new THREE.Vector2(0.09, 0.012),
    new THREE.Vector2(0.10, 0.0),
    new THREE.Vector2(0.14, 0.02),
    new THREE.Vector2(0.19, 0.07),
    new THREE.Vector2(BOWL_R, BOWL_H * 0.9),
    new THREE.Vector2(BOWL_R + 0.005, BOWL_H),
  ]
  const outer = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), MAT.ceramic)
  outer.castShadow = true
  outer.receiveShadow = true
  const innerProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.001, 0.03),
    new THREE.Vector2(0.11, 0.035),
    new THREE.Vector2(0.175, 0.075),
    new THREE.Vector2(BOWL_R - 0.008, BOWL_H * 0.92),
    new THREE.Vector2(BOWL_R + 0.005, BOWL_H),
  ]
  const geoIn = new THREE.LatheGeometry(innerProfile, 28)
  const inner = new THREE.Mesh(geoIn, MAT.ceramicIn)
  inner.material = MAT.ceramicIn
  ;(inner.material as THREE.MeshStandardMaterial).side = THREE.BackSide
  g.add(outer, inner)
  return g
}

// ---------------------------------------------------------------------------
// Source tub (給水口)
// ---------------------------------------------------------------------------

export function buildSourceTub(): THREE.Group {
  const g = new THREE.Group()
  // wooden tub, positioned behind local origin (spout runs from origin toward +Z)
  const tub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.26, 18), MAT.wood)
  tub.position.set(0, 0.02, -0.16)
  tub.castShadow = true
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.012, 6, 18), MAT.woodDark)
  rim.rotation.x = Math.PI / 2
  rim.position.set(0, 0.14, -0.16)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.162, 0.162, 0.02, 18, 1, true), MAT.woodDark)
  band.position.set(0, -0.04, -0.16)
  // water surface inside the tub
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(0.145, 18),
    new THREE.MeshStandardMaterial({ color: 0x9fd4e8, roughness: 0.1, transparent: true, opacity: 0.85 }),
  )
  water.rotation.x = -Math.PI / 2
  water.position.set(0, 0.115, -0.16)
  g.add(tub, rim, band, water)
  return g
}
