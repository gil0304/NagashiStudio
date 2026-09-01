import * as THREE from 'three'

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)

const _projTmp = new THREE.Vector3()

/** Polyline sampled channel: arc-length parameterized centerline of a bamboo trough. */
export class Channel {
  points: THREE.Vector3[] // local-space centerline (bottom of the water column = center of half-pipe circle)
  cumLen: number[]
  length: number

  constructor(points: THREE.Vector3[]) {
    this.points = points
    this.cumLen = [0]
    for (let i = 1; i < points.length; i++) {
      this.cumLen.push(this.cumLen[i - 1] + points[i].distanceTo(points[i - 1]))
    }
    this.length = this.cumLen[this.cumLen.length - 1]
  }

  /** Position at arc length s (clamped). Writes into out. */
  posAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const cl = this.cumLen
    if (s <= 0) return out.copy(this.points[0])
    if (s >= this.length) return out.copy(this.points[this.points.length - 1])
    let i = this.seg(s)
    const t = (s - cl[i]) / (cl[i + 1] - cl[i])
    return out.copy(this.points[i]).lerp(this.points[i + 1], t)
  }

  /** Unit tangent at arc length s. Writes into out. */
  tanAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.seg(THREE.MathUtils.clamp(s, 0, this.length - 1e-6))
    return out.copy(this.points[i + 1]).sub(this.points[i]).normalize()
  }

  private seg(s: number): number {
    const cl = this.cumLen
    let lo = 0
    let hi = cl.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cl[mid] <= s) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Like project(), but only searches segments within `win` meters of arc position s0. */
  projectNear(p: THREE.Vector3, s0: number, win = 0.7): number {
    const cl = this.cumLen
    let bestS = -1
    let bestD = Infinity
    for (let i = 0; i < this.points.length - 1; i++) {
      if (cl[i + 1] < s0 - win || cl[i] > s0 + win) continue
      const p0 = this.points[i]
      const p1 = this.points[i + 1]
      const ax = p1.x - p0.x
      const ay = p1.y - p0.y
      const az = p1.z - p0.z
      const len2 = ax * ax + ay * ay + az * az
      let t = len2 > 0 ? ((p.x - p0.x) * ax + (p.y - p0.y) * ay + (p.z - p0.z) * az) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const dx = p.x - (p0.x + ax * t)
      const dy = p.y - (p0.y + ay * t)
      const dz = p.z - (p0.z + az * t)
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) {
        bestD = d
        bestS = cl[i] + Math.sqrt(len2) * t
      }
    }
    if (bestS < 0) return this.project(p, _projTmp)
    return bestS
  }

  /** Project a local-space point onto the channel; returns arc length s and stores closest point. */
  project(p: THREE.Vector3, tmp: THREE.Vector3): number {
    let bestS = 0
    let bestD = Infinity
    const a = tmp
    for (let i = 0; i < this.points.length - 1; i++) {
      const p0 = this.points[i]
      const p1 = this.points[i + 1]
      a.copy(p1).sub(p0)
      const len2 = a.lengthSq()
      let t = len2 > 0 ? THREE.MathUtils.clamp(p.clone().sub(p0).dot(a) / len2, 0, 1) : 0
      const cx = p0.x + a.x * t
      const cy = p0.y + a.y * t
      const cz = p0.z + a.z * t
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2
      if (d < bestD) {
        bestD = d
        bestS = this.cumLen[i] + Math.sqrt(len2) * t
      }
    }
    return bestS
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

let idCounter = 0
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`
}
