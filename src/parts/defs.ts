import * as THREE from 'three'
import { Channel } from '../util/math'
import {
  buildTrough, buildBowl, buildSourceTub, makeInnerMaterial,
  MAT, BAMBOO_R_IN, BOWL_R,
} from './geometry'

export interface Outlet {
  channelIndex: number
  pos: THREE.Vector3 // local position of the outlet (channel end)
  yawOffset: number // horizontal heading change from part entry to this outlet
}

export interface BuiltPart {
  group: THREE.Group
  channels: Channel[] // local-space centerlines (circle centers of the trough)
  innerMat: THREE.MeshStandardMaterial | null // per-instance material (wetness darkening)
  outlets: Outlet[]
  hasInput: boolean
}

export interface PartDef {
  id: string
  label: string
  icon: string
  category: string
  hasPitch: boolean
  defaultPitch: number // radians, applied as rotation.x (positive = downhill toward +Z)
  defaultY: number
  isSource?: boolean
  isGoal?: boolean
  build(): BuiltPart
}

const deg = (d: number) => (d * Math.PI) / 180

// ---------------------------------------------------------------------------

function straightChannel(len: number): Channel {
  const pts: THREE.Vector3[] = []
  const n = Math.max(2, Math.round(len / 0.25) + 1)
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3(0, 0, (i / (n - 1)) * len))
  return new Channel(pts)
}

/** Horizontal arc: dir=+1 turns left (+X), dir=-1 turns right. Starts at origin heading +Z. */
function curveChannel(angleDeg: number, radius: number, dir: number): Channel {
  const pts: THREE.Vector3[] = []
  const n = Math.max(6, Math.round(angleDeg / 6))
  const A = deg(angleDeg)
  for (let i = 0; i <= n; i++) {
    const phi = (i / n) * A
    pts.push(new THREE.Vector3(dir * radius * (1 - Math.cos(phi)), 0, radius * Math.sin(phi)))
  }
  return new Channel(pts)
}

function troughPart(channel: Channel, opts?: Parameters<typeof buildTrough>[2]): BuiltPart {
  const innerMat = makeInnerMaterial()
  const g = new THREE.Group()
  const t = buildTrough(channel, innerMat, opts)
  g.add(t.outer, t.inner, t.extras)
  const end = channel.points[channel.points.length - 1]
  const tan = new THREE.Vector3()
  channel.tanAt(channel.length, tan)
  return {
    group: g,
    channels: [channel],
    innerMat,
    outlets: [{ channelIndex: 0, pos: end.clone(), yawOffset: Math.atan2(tan.x, tan.z) }],
    hasInput: true,
  }
}

// ---------------------------------------------------------------------------
// Branch (Y分岐): trunk trough -> wooden splitter box -> two diverging arm troughs
// ---------------------------------------------------------------------------

const BRANCH_ANGLE = deg(20)

function branchArmPoints(dir: number): THREE.Vector3[] {
  const sin = Math.sin(BRANCH_ANGLE) * dir
  const cos = Math.cos(BRANCH_ANGLE)
  const start = new THREE.Vector3(dir * 0.085, -0.015, 0.63)
  const pts = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 0.4),
    new THREE.Vector3(dir * 0.025, -0.008, 0.48),
    new THREE.Vector3(dir * 0.06, -0.012, 0.56),
    start.clone(),
  ]
  const armLen = 0.55
  for (const t of [0.33, 0.66, 1]) {
    pts.push(new THREE.Vector3(start.x + sin * armLen * t, start.y - 0.03 * t, start.z + cos * armLen * t))
  }
  return pts
}

function buildBranch(): BuiltPart {
  const innerMat = makeInnerMaterial()
  const g = new THREE.Group()

  const chL = new Channel(branchArmPoints(1))
  const chR = new Channel(branchArmPoints(-1))

  // visual troughs: trunk once, then each arm from the box onward
  const trunk = buildTrough(new Channel([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.4)]), innerMat, { capEnd: false })
  g.add(trunk.outer, trunk.inner, trunk.extras)
  for (const dir of [1, -1]) {
    const full = branchArmPoints(dir)
    const armPts = full.slice(4).map((p) => p.clone())
    const arm = buildTrough(new Channel(armPts), innerMat, { capStart: false })
    g.add(arm.outer, arm.inner, arm.extras)
  }

  // splitter box (open toward upstream so the trunk trough runs straight in)
  const box = new THREE.Group()
  const floor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.016, 0.3), MAT.wood)
  floor.position.set(0, -0.064, 0.53)
  floor.rotation.x = deg(2.5)
  const wallGeo = new THREE.BoxGeometry(0.014, 0.055, 0.3)
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wallGeo, MAT.wood)
    w.position.set(s * 0.138, -0.032, 0.53)
    box.add(w)
  }
  // V-shaped splitter wedge (apex upstream)
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.16), MAT.woodDark)
    w.position.set(s * 0.028, -0.038, 0.6)
    w.rotation.y = -s * deg(19)
    box.add(w)
  }
  box.add(floor)
  box.traverse((o) => { o.castShadow = true })
  g.add(box)

  const tanEnd = new THREE.Vector3()
  chL.tanAt(chL.length, tanEnd)
  const outlets: Outlet[] = [
    { channelIndex: 0, pos: chL.points[chL.points.length - 1].clone(), yawOffset: BRANCH_ANGLE },
    { channelIndex: 1, pos: chR.points[chR.points.length - 1].clone(), yawOffset: -BRANCH_ANGLE },
  ]
  return { group: g, channels: [chL, chR], innerMat, outlets, hasInput: true }
}

// ---------------------------------------------------------------------------
// Source (給水口)
// ---------------------------------------------------------------------------

function buildSource(): BuiltPart {
  const innerMat = makeInnerMaterial()
  const g = new THREE.Group()
  const ch = new Channel([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -0.018, 0.18),
    new THREE.Vector3(0, -0.035, 0.35),
  ])
  const t = buildTrough(ch, innerMat, { capStart: false, nodeEvery: 10 })
  g.add(t.outer, t.inner, t.extras)
  g.add(buildSourceTub())
  return {
    group: g,
    channels: [ch],
    innerMat,
    outlets: [{ channelIndex: 0, pos: new THREE.Vector3(0, -0.035, 0.35), yawOffset: 0 }],
    hasInput: false,
  }
}

// ---------------------------------------------------------------------------
// Goal bowl (器)
// ---------------------------------------------------------------------------

function buildGoal(): BuiltPart {
  const g = new THREE.Group()
  g.add(buildBowl())
  return { group: g, channels: [], innerMat: null, outlets: [], hasInput: false }
}

// ---------------------------------------------------------------------------

export const PART_DEFS: PartDef[] = [
  { id: 'bamboo_1m', label: '竹（短・1m）', icon: '▬', category: '竹', hasPitch: true, defaultPitch: deg(4), defaultY: 0.9, build: () => troughPart(straightChannel(1)) },
  { id: 'bamboo_2m', label: '竹（長・2m）', icon: '▬▬', category: '竹', hasPitch: true, defaultPitch: deg(4), defaultY: 0.9, build: () => troughPart(straightChannel(2)) },
  { id: 'curve_l45', label: 'カーブ 左45°', icon: '↰', category: '竹', hasPitch: false, defaultPitch: 0, defaultY: 0.9, build: () => troughPart(curveChannel(45, 0.75, 1)) },
  { id: 'curve_r45', label: 'カーブ 右45°', icon: '↱', category: '竹', hasPitch: false, defaultPitch: 0, defaultY: 0.9, build: () => troughPart(curveChannel(45, 0.75, -1)) },
  { id: 'curve_l90', label: 'カーブ 左90°', icon: '↶', category: '竹', hasPitch: false, defaultPitch: 0, defaultY: 0.9, build: () => troughPart(curveChannel(90, 0.65, 1)) },
  { id: 'curve_r90', label: 'カーブ 右90°', icon: '↷', category: '竹', hasPitch: false, defaultPitch: 0, defaultY: 0.9, build: () => troughPart(curveChannel(90, 0.65, -1)) },
  { id: 'branch', label: 'Y分岐', icon: '⑂', category: '竹', hasPitch: false, defaultPitch: 0, defaultY: 0.9, build: buildBranch },
  { id: 'source', label: '給水口', icon: '🚰', category: '装置', hasPitch: false, defaultPitch: 0, defaultY: 1.25, isSource: true, build: buildSource },
  { id: 'goal_bowl', label: '受け鉢', icon: '🥣', category: 'ゴール', hasPitch: false, defaultPitch: 0, defaultY: 0, isGoal: true, build: buildGoal },
]

export const DEF_BY_ID = new Map(PART_DEFS.map((d) => [d.id, d]))
export { BAMBOO_R_IN, BOWL_R }
