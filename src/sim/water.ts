import { Course, PartInstance, WorldChannel } from '../course/course'
import { BAMBOO_R_IN } from '../parts/geometry'
import { INNER_DRY, INNER_WET } from '../parts/geometry'

export const MAX_Q = 0.0013 // m^3/s at slider = 1
const FLOW_C = 3.1 // velocity coefficient: v = C * sqrt(slope)
const MIN_SLOPE = 0.012 // effective slope floor (lets flat curves keep some speed)
const R = BAMBOO_R_IN

/** Cross-section area of water depth d in a circular trough of radius r. */
function segmentArea(d: number, r: number): number {
  d = Math.min(d, r * 2)
  return r * r * Math.acos(1 - d / r) - (r - d) * Math.sqrt(Math.max(2 * r * d - d * d, 0))
}

/** Invert segmentArea: depth that carries area A. */
function depthForArea(A: number, r: number): number {
  let lo = 0
  let hi = r * 1.4
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (segmentArea(mid, r) < A) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export interface SpillEvent {
  x: number
  y: number
  z: number
  rate: number // relative spill intensity 0..1
}

/**
 * 1D open-channel flow over the course graph.
 * Each WorldChannel keeps a FlowState; water advances with a leading edge (front),
 * stalls on adverse slopes, splits at branches and discharges at open ends.
 */
export class WaterSim {
  /** UI slider 0..1 */
  sourceFlow = 0.6
  /** open channel ends currently discharging: for waterfall particles */
  discharges: Array<{ wc: WorldChannel }> = []
  spills: SpillEvent[] = []
  totalFlow = 0 // for audio

  update(course: Course, dt: number): void {
    this.discharges.length = 0
    this.spills.length = 0
    this.totalFlow = 0

    const all = course.allChannels()
    for (const wc of all) wc.flow.Q = 0

    // propagate Q from sources through the DAG
    for (const src of course.sources()) {
      if (src.worldChannels.length === 0) continue
      const Q = this.sourceFlow * MAX_Q
      this.feed(course, src.worldChannels[0], Q, dt, 0)
    }

    // relax states + collect discharge points, wetness
    for (const wc of all) {
      const f = wc.flow
      const slope = wc.slope
      f.stalled = f.Q > 1e-7 && slope < -0.004

      let vT = 0
      let dT = 0
      if (f.Q > 1e-7) {
        if (f.stalled) {
          vT = 0.02
          dT = R * 0.95
        } else {
          const eff = Math.max(slope, MIN_SLOPE)
          vT = FLOW_C * Math.sqrt(eff)
          const A = f.Q / vT
          dT = Math.min(depthForArea(A, R), R * 0.95)
        }
      }
      const k = Math.min(1, dt * 3.5)
      f.v += (vT - f.v) * k
      f.depth += (dT - f.depth) * k
      if (dT === 0 && f.depth < 0.0004) f.depth = 0 // snap to dry only when draining

      // leading edge
      if (f.Q > 1e-7) {
        f.front = Math.min(wc.ch.length, f.front + Math.max(f.v, 0.15) * dt)
      } else {
        f.front = Math.max(0, f.front - 1.4 * dt)
        if (f.front <= 0) { f.v = 0; f.depth = Math.max(0, f.depth - dt * 0.05) }
      }

      // turbulence: speed + part shape
      const shapeTurb = wc.part.def.id.startsWith('curve') ? 0.25 : wc.part.def.id === 'branch' ? 0.3 : 0
      f.turb = Math.min(1, f.v / 1.4 + shapeTurb * Math.min(1, f.v * 2))

      this.totalFlow += f.Q * (f.front / Math.max(wc.ch.length, 0.01))

      // discharge at open filled ends
      const child = wc.part.children[wc.index]
      if (f.Q > 1e-7 && !child && f.front >= wc.ch.length - 1e-3) {
        this.discharges.push({ wc })
      }

      // stalled water pools & spills over the rim near the low end
      if (f.stalled && f.depth > R * 0.9) {
        const p = wc.ch.points[wc.slope < 0 ? 0 : wc.ch.points.length - 1]
        this.spills.push({ x: p.x, y: p.y, z: p.z, rate: Math.min(1, f.Q / MAX_Q) })
      }
    }

    // wetness -> inner material tint
    for (const part of course.parts.values()) {
      let wet = false
      for (const wc of part.worldChannels) if (wc.flow.depth > 0.0008) { wet = true; break }
      part.wetness = Math.max(0, Math.min(1, part.wetness + (wet ? dt / 1.5 : -dt / 60)))
      const m = part.built.innerMat
      if (m) {
        m.color.copy(INNER_DRY).lerp(INNER_WET, part.wetness * 0.85)
        m.roughness = 0.55 - part.wetness * 0.38
      }
    }
  }

  private feed(course: Course, wc: WorldChannel, Q: number, dt: number, depthGuard: number): void {
    if (depthGuard > 64) return
    wc.flow.Q += Q
    const child = wc.part.children[wc.index]
    if (!child || child.worldChannels.length === 0) return
    // downstream only receives water once this channel has filled
    if (wc.flow.front < wc.ch.length - 1e-3) return
    let out = Q
    if (wc.flow.stalled) out = Q * 0.35 // pooled water dribbles onward
    if (child.worldChannels.length > 1) {
      for (const cwc of child.worldChannels) this.feed(course, cwc, out / child.worldChannels.length, dt, depthGuard + 1)
    } else {
      this.feed(course, child.worldChannels[0], out, dt, depthGuard + 1)
    }
  }
}

/** Water surface half-width at depth d. */
export function surfaceHalfWidth(d: number): number {
  const t = R - Math.min(d, R)
  return Math.sqrt(Math.max(R * R - t * t, 0.0004)) * 0.98
}
