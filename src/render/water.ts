import * as THREE from 'three'
import { Course, PartInstance, WorldChannel } from '../course/course'
import { WaterSim, MAX_Q, surfaceHalfWidth } from '../sim/water'
import { BAMBOO_R_IN, BOWL_R, BOWL_H } from '../parts/geometry'
import { SplashSystem } from './particles'

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
uniform float uTime;
uniform float uSpeed;
uniform float uTurb;
uniform vec3 uSunDir;
uniform vec3 uCam;

float nz(vec2 p) {
  return sin(p.x) * sin(p.y);
}

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float t = uTime;
  float sp = max(uSpeed, 0.08);

  // layered scrolling ripples -> perturbed normal
  float h1 = nz(vec2(u * 34.0 - t * sp * 7.0, v * 6.0 + u * 5.0));
  float h2 = nz(vec2(u * 90.0 - t * sp * 16.0 + v * 4.0, v * 14.0 - t * 2.0));
  float h3 = nz(vec2(u * 18.0 - t * sp * 3.5, v * 3.0));
  vec3 n = normalize(vec3(
    (h1 * 0.55 + h2 * 0.3) * (0.25 + uTurb * 0.5),
    1.0,
    (h3 * 0.5 + h2 * 0.25) * (0.2 + uTurb * 0.4)
  ));

  vec3 viewDir = normalize(uCam - vWorld);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

  vec3 deep = vec3(0.12, 0.38, 0.5);
  vec3 shallow = vec3(0.5, 0.78, 0.85);
  vec3 col = mix(shallow, deep, 0.45 + 0.3 * h3);
  vec3 sky = vec3(0.72, 0.86, 0.98);
  col = mix(col, sky, fres * 0.85);

  // sun sparkle
  vec3 hv = normalize(viewDir + normalize(uSunDir));
  float spec = pow(max(dot(n, hv), 0.0), 140.0) * (1.2 + uTurb);
  col += vec3(spec);

  // foam: rim contact lines + turbulence streaks
  float edge = smoothstep(0.14, 0.03, v) + smoothstep(0.86, 0.97, v);
  float streak = smoothstep(0.55, 0.95, nz(vec2(u * 46.0 - t * sp * 12.0, v * 9.0 + u * 6.0)) * 0.5 + 0.5);
  float foam = clamp(edge * 0.55 + streak * uTurb * 0.8, 0.0, 1.0);
  col = mix(col, vec3(0.97, 0.99, 1.0), foam * 0.8);

  float alpha = 0.42 + fres * 0.3 + foam * 0.45 + uTurb * 0.1;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92));
}
`

const UP = new THREE.Vector3(0, 1, 0)
const _c = new THREE.Vector3()
const _t = new THREE.Vector3()
const _s = new THREE.Vector3()

const RING_STEP = 0.06

class ChannelWater {
  mesh: THREE.Mesh
  geo: THREE.BufferGeometry
  pos: Float32Array
  uv: Float32Array
  maxRings: number
  uniforms: Record<string, THREE.IUniform>

  constructor(length: number, sunDir: THREE.Vector3) {
    this.maxRings = Math.ceil(length / RING_STEP) + 3
    this.pos = new Float32Array(this.maxRings * 2 * 3)
    this.uv = new Float32Array(this.maxRings * 2 * 2)
    const idx: number[] = []
    for (let i = 0; i < this.maxRings - 1; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2))
    this.geo.setIndex(idx)
    this.uniforms = {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uTurb: { value: 0 },
      uSunDir: { value: sunDir },
      uCam: { value: new THREE.Vector3() },
    }
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
  }

  sync(wc: WorldChannel, time: number, cam: THREE.Vector3): void {
    const f = wc.flow
    if (f.depth < 0.0015 || f.front < 0.02) {
      this.mesh.visible = false
      return
    }
    this.mesh.visible = true
    const rings = Math.min(this.maxRings, Math.max(2, Math.ceil(f.front / RING_STEP) + 1))
    for (let i = 0; i < rings; i++) {
      const s = Math.min((i / (rings - 1)) * f.front, wc.ch.length)
      wc.ch.posAt(s, _c)
      wc.ch.tanAt(s, _t)
      _s.crossVectors(UP, _t)
      if (_s.lengthSq() < 1e-8) _s.set(1, 0, 0)
      _s.normalize()
      // taper depth toward the advancing front
      const frontFade = f.front < wc.ch.length - 1e-3 ? Math.min(1, (f.front - s) / 0.25 + 0.25) : 1
      const d = f.depth * frontFade
      const hw = surfaceHalfWidth(d)
      const y = _c.y - BAMBOO_R_IN + d + 0.002
      const k = i * 6
      this.pos[k] = _c.x - _s.x * hw
      this.pos[k + 1] = y
      this.pos[k + 2] = _c.z - _s.z * hw
      this.pos[k + 3] = _c.x + _s.x * hw
      this.pos[k + 4] = y
      this.pos[k + 5] = _c.z + _s.z * hw
      const ku = i * 4
      this.uv[ku] = s * 1.0
      this.uv[ku + 1] = 0
      this.uv[ku + 2] = s * 1.0
      this.uv[ku + 3] = 1
    }
    this.geo.setDrawRange(0, (rings - 1) * 6)
    ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.attributes.uv as THREE.BufferAttribute).needsUpdate = true
    this.uniforms.uTime.value = time
    this.uniforms.uSpeed.value = f.v
    this.uniforms.uTurb.value = f.turb
    ;(this.uniforms.uCam.value as THREE.Vector3).copy(cam)
  }

  dispose(): void {
    this.geo.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

const bowlWaterMat = new THREE.MeshStandardMaterial({
  color: 0x9fd4e2, roughness: 0.08, metalness: 0,
  transparent: true, opacity: 0.8,
})

export class WaterRender {
  private root = new THREE.Group()
  private channels = new Map<string, ChannelWater>()
  private bowlMeshes = new Map<string, THREE.Mesh>()
  private sunDir: THREE.Vector3

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    this.sunDir = sunDir
    scene.add(this.root)
  }

  update(course: Course, sim: WaterSim, splash: SplashSystem, dt: number, time: number, cam: THREE.Vector3): void {
    // (re)build meshes for current channels
    const seen = new Set<string>()
    for (const wc of course.allChannels()) {
      const key = `${wc.part.id}:${wc.index}`
      seen.add(key)
      let cw = this.channels.get(key)
      if (!cw || cw.maxRings < Math.ceil(wc.ch.length / RING_STEP) + 3) {
        cw?.dispose()
        if (cw) this.root.remove(cw.mesh)
        cw = new ChannelWater(wc.ch.length, this.sunDir)
        this.channels.set(key, cw)
        this.root.add(cw.mesh)
      }
      cw.sync(wc, time, cam)
    }
    for (const [key, cw] of this.channels) {
      if (!seen.has(key)) {
        this.root.remove(cw.mesh)
        cw.dispose()
        this.channels.delete(key)
      }
    }

    // waterfalls at open discharging ends
    for (const d of sim.discharges) {
      const f = d.wc.flow
      const rate = (f.Q / MAX_Q) * 1500 * dt
      const n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0)
      const end = d.wc.ch.points[d.wc.ch.points.length - 1]
      d.wc.ch.tanAt(d.wc.ch.length, _t)
      _s.crossVectors(UP, _t).normalize()
      const hw = surfaceHalfWidth(f.depth) * 0.7
      for (let i = 0; i < n; i++) {
        const lat = (Math.random() * 2 - 1) * hw
        splash.spawn(
          end.x + _s.x * lat, end.y - BAMBOO_R_IN + f.depth * Math.random() + 0.004, end.z + _s.z * lat,
          _t.x * f.v * (0.85 + Math.random() * 0.3), _t.y * f.v + Math.random() * 0.1, _t.z * f.v * (0.85 + Math.random() * 0.3),
          1.4, 0.02 + Math.random() * 0.02, 0,
        )
      }
    }

    // rim spills from stalled pools
    for (const sp of sim.spills) {
      const n = Math.random() < sp.rate * dt * 35 ? 1 : 0
      for (let i = 0; i < n; i++) {
        splash.spawn(
          sp.x + (Math.random() - 0.5) * 0.06, sp.y + 0.02, sp.z + (Math.random() - 0.5) * 0.06,
          (Math.random() - 0.5) * 0.2, 0.05, (Math.random() - 0.5) * 0.2,
          1.2, 0.018, 0,
        )
      }
    }

    // spray on fast turbulent sections
    for (const wc of course.allChannels()) {
      const f = wc.flow
      if (f.turb > 0.5 && f.depth > 0.004 && Math.random() < (f.turb - 0.5) * dt * 26) {
        const s = Math.random() * f.front
        wc.ch.posAt(s, _c)
        wc.ch.tanAt(s, _t)
        splash.spawn(
          _c.x, _c.y - BAMBOO_R_IN + f.depth + 0.01, _c.z,
          _t.x * f.v * 0.7 + (Math.random() - 0.5) * 0.15, 0.25 + Math.random() * 0.25, _t.z * f.v * 0.7 + (Math.random() - 0.5) * 0.15,
          0.45, 0.014 + Math.random() * 0.012, 1,
        )
      }
    }

    // bowl water levels
    const bowls = course.bowls()
    const seenBowl = new Set<string>()
    for (const b of bowls) {
      seenBowl.add(b.id)
      let m = this.bowlMeshes.get(b.id)
      if (!m) {
        m = new THREE.Mesh(new THREE.CircleGeometry(1, 24), bowlWaterMat)
        m.rotation.x = -Math.PI / 2
        m.renderOrder = 1
        this.bowlMeshes.set(b.id, m)
        this.root.add(m)
      }
      b.bowlFill = Math.max(0, b.bowlFill - dt * 0.012)
      const fill = b.bowlFill
      m.visible = fill > 0.02
      const y = b.pos.y + 0.05 + fill * (BOWL_H - 0.07)
      const r = 0.1 + fill * (BOWL_R * 0.82 - 0.1)
      m.position.set(b.pos.x, y, b.pos.z)
      m.scale.setScalar(r)
    }
    for (const [id, m] of this.bowlMeshes) {
      if (!seenBowl.has(id)) {
        this.root.remove(m)
        m.geometry.dispose()
        this.bowlMeshes.delete(id)
      }
    }
  }
}
