import * as THREE from 'three'
import { PartInstance } from '../course/course'
import { BOWL_R, BOWL_H } from '../parts/geometry'

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio * (240.0 / max(-mv.z, 0.1));
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
precision mediump float;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, 0.12, d) * vAlpha;
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.75, 0.88, 0.96), vec3(1.0), smoothstep(0.35, 0.0, d));
  gl_FragColor = vec4(col, a);
}
`

export interface SplashHit {
  x: number
  y: number
  z: number
  bowl: PartInstance | null
}

/** Pooled point-sprite droplets: waterfalls, spray, impact bursts. */
export class SplashSystem {
  private cap: number
  private posArr: Float32Array
  private sizeArr: Float32Array
  private alphaArr: Float32Array
  private vel: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private kind: Uint8Array // 0 = primary droplet (spawns mini burst on impact), 1 = spray
  private head = 0
  private geo: THREE.BufferGeometry
  points: THREE.Points
  /** impacts recorded during the last update (for audio / bowl fill) */
  hits: SplashHit[] = []

  constructor(scene: THREE.Scene, capacity = 2600) {
    this.cap = capacity
    this.posArr = new Float32Array(capacity * 3)
    this.sizeArr = new Float32Array(capacity)
    this.alphaArr = new Float32Array(capacity)
    this.vel = new Float32Array(capacity * 3)
    this.life = new Float32Array(capacity)
    this.maxLife = new Float32Array(capacity)
    this.kind = new Uint8Array(capacity)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3))
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizeArr, 1))
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaArr, 1))
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) } },
      transparent: true,
      depthWrite: false,
    })
    this.points = new THREE.Points(this.geo, mat)
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: 0 | 1): void {
    const i = this.head
    this.head = (this.head + 1) % this.cap
    this.posArr[i * 3] = x
    this.posArr[i * 3 + 1] = y
    this.posArr[i * 3 + 2] = z
    this.vel[i * 3] = vx
    this.vel[i * 3 + 1] = vy
    this.vel[i * 3 + 2] = vz
    this.life[i] = life
    this.maxLife[i] = life
    this.sizeArr[i] = size
    this.kind[i] = kind
  }

  burst(x: number, y: number, z: number, n: number, speed: number, kind: 0 | 1 = 1): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const up = 0.4 + Math.random() * 0.9
      const r = Math.random() * speed
      this.spawn(x, y, z, Math.cos(a) * r, up * speed, Math.sin(a) * r, 0.3 + Math.random() * 0.35, 0.015 + Math.random() * 0.02, kind)
    }
  }

  update(dt: number, bowls: PartInstance[]): void {
    this.hits.length = 0
    const g = -9.81 * 0.92
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        this.alphaArr[i] = 0
        continue
      }
      this.life[i] -= dt
      const i3 = i * 3
      this.vel[i3 + 1] += g * dt
      this.posArr[i3] += this.vel[i3] * dt
      this.posArr[i3 + 1] += this.vel[i3 + 1] * dt
      this.posArr[i3 + 2] += this.vel[i3 + 2] * dt
      const x = this.posArr[i3]
      const y = this.posArr[i3 + 1]
      const z = this.posArr[i3 + 2]
      this.alphaArr[i] = Math.min(1, (this.life[i] / this.maxLife[i]) * 1.6) * 0.75

      let killed = false
      if (this.vel[i3 + 1] < 0) {
        // bowl catch
        for (const b of bowls) {
          const hd = Math.hypot(x - b.pos.x, z - b.pos.z)
          const waterY = b.pos.y + 0.05 + b.bowlFill * (BOWL_H - 0.06)
          if (hd < BOWL_R * 0.92 && y < waterY + 0.01) {
            killed = true
            if (this.kind[i] === 0) {
              this.hits.push({ x, y, z, bowl: b })
              if (Math.random() < 0.3) this.burst(x, waterY + 0.005, z, 3, 0.25)
            }
            break
          }
        }
        // ground
        if (!killed && y < 0.006) {
          killed = true
          if (this.kind[i] === 0) {
            this.hits.push({ x, y: 0, z, bowl: null })
            if (Math.random() < 0.25) this.burst(x, 0.008, z, 3, 0.2)
          }
        }
      }
      if (killed || this.life[i] <= 0) {
        this.life[i] = 0
        this.alphaArr[i] = 0
      }
    }
    ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
  }
}
