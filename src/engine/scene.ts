import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MAT } from '../parts/geometry'

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const SKY_FRAG = /* glsl */ `
precision mediump float;
varying vec3 vDir;
uniform vec3 uSunDir;
void main() {
  float h = clamp(vDir.y, -0.1, 1.0);
  vec3 zenith = vec3(0.18, 0.45, 0.85);
  vec3 horizon = vec3(0.84, 0.92, 0.97);
  vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
  float sun = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
  col += vec3(1.0, 0.95, 0.8) * pow(sun, 350.0) * 2.2; // disc
  col += vec3(1.0, 0.9, 0.7) * pow(sun, 8.0) * 0.16;   // glow
  gl_FragColor = vec4(col, 1.0);
}
`

function cloudTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, 256, 256)
  for (let i = 0; i < 26; i++) {
    const x = 40 + Math.random() * 176
    const y = 90 + Math.random() * 80
    const r = 22 + Math.random() * 34
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 7)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function bambooClump(): THREE.Group {
  const g = new THREE.Group()
  const culmMat = new THREE.MeshStandardMaterial({ color: 0x5e8f45, roughness: 0.6 })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3e6b34, roughness: 0.8, side: THREE.DoubleSide })
  const n = 3 + Math.floor(Math.random() * 3)
  for (let i = 0; i < n; i++) {
    const h = 2.6 + Math.random() * 2
    const culm = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.04, h, 6), culmMat)
    const x = (Math.random() - 0.5) * 0.7
    const z = (Math.random() - 0.5) * 0.7
    culm.position.set(x, h / 2, z)
    culm.rotation.z = (Math.random() - 0.5) * 0.1
    culm.castShadow = true
    g.add(culm)
    for (let j = 0; j < 4; j++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.35 + Math.random() * 0.3, 0.9, 5), leafMat)
      leaf.position.set(x + (Math.random() - 0.5) * 0.5, h - 0.5 - j * 0.4, z + (Math.random() - 0.5) * 0.5)
      leaf.rotation.set(Math.random() * 0.6 - 0.3, Math.random() * Math.PI, Math.random() * 0.6 - 0.3)
      leaf.scale.y = 0.45
      g.add(leaf)
    }
  }
  return g
}

function deck(): THREE.Group {
  const g = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.05, 0.42), MAT.wood)
    plank.position.set(0, 0.42, i * 0.46 - 1.15)
    plank.castShadow = true
    plank.receiveShadow = true
    g.add(plank)
  }
  for (const [x, z] of [[-1.5, -1], [1.5, -1], [-1.5, 1], [1.5, 1]] as Array<[number, number]>) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.12), MAT.woodDark)
    leg.position.set(x, 0.21, z)
    g.add(leg)
  }
  return g
}

export class Stage {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  sun: THREE.DirectionalLight
  sunDir = new THREE.Vector3(5, 8, 3).normalize()
  ground: THREE.Mesh
  private clouds: THREE.Sprite[] = []
  /** WASD/RF free-fly state (camera and orbit pivot move together) */
  private moveKeys = new Set<string>()
  private moveFast = false

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 120)
    this.camera.position.set(3.4, 2.4, 4.6)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 0.8, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.minDistance = 0.4
    this.controls.maxDistance = 20

    this.scene.fog = new THREE.Fog(0xd7e8f2, 26, 60)

    // sky
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(70, 24, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: { uSunDir: { value: this.sunDir } },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    )
    this.scene.add(sky)

    // clouds
    const ctex = cloudTexture()
    for (let i = 0; i < 7; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ctex, transparent: true, opacity: 0.9, depthWrite: false, fog: false }))
      const a = (i / 7) * Math.PI * 2 + Math.random()
      sp.position.set(Math.cos(a) * (28 + Math.random() * 18), 13 + Math.random() * 9, Math.sin(a) * (28 + Math.random() * 18))
      const s = 14 + Math.random() * 12
      sp.scale.set(s, s * 0.5, 1)
      this.clouds.push(sp)
      this.scene.add(sp)
    }

    // lights
    this.sun = new THREE.DirectionalLight(0xfff2dc, 3.0)
    this.sun.position.copy(this.sunDir).multiplyScalar(14)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.left = -14
    this.sun.shadow.camera.right = 14
    this.sun.shadow.camera.top = 14
    this.sun.shadow.camera.bottom = -14
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 40
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.02
    this.scene.add(this.sun)
    this.scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x8a9a6b, 0.75))

    // ground
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(34, 48), MAT.grass)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    // props
    const grovePositions: Array<[number, number, number]> = [
      [-7, -6, 1.4], [-9, 2, 1.1], [7.5, -5, 1.2], [9, 3, 1.5], [2, -9, 1], [-3, 8.5, 1.3], [6, 7.5, 1.1],
    ]
    for (const [x, z, s] of grovePositions) {
      const clump = bambooClump()
      clump.position.set(x, 0, z)
      clump.scale.setScalar(s)
      this.scene.add(clump)
    }
    const d = deck()
    d.position.set(-1, 0, -5.2)
    d.rotation.y = 0.15
    this.scene.add(d)
    for (const [x, z, s] of [[4.5, -3.5, 0.3], [5.1, -3.2, 0.2], [-5.5, 4, 0.35]] as Array<[number, number, number]>) {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), MAT.stone)
      rock.position.set(x, s * 0.4, z)
      rock.scale.set(s, s * 0.6, s * 0.8)
      rock.rotation.y = Math.random() * 3
      rock.castShadow = true
      this.scene.add(rock)
    }

    this.resize()
    window.addEventListener('resize', () => this.resize())

    // free-fly movement keys
    const MOVE = new Set(['w', 'a', 's', 'd', 'r', 'f'])
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (MOVE.has(k)) this.moveKeys.add(k)
      this.moveFast = e.shiftKey
    })
    window.addEventListener('keyup', (e) => {
      this.moveKeys.delete(e.key.toLowerCase())
      this.moveFast = e.shiftKey
    })
    window.addEventListener('blur', () => this.moveKeys.clear())
  }

  private applyFreeMove(dt: number): void {
    if (this.moveKeys.size === 0) return
    const speed = (this.moveFast ? 7.5 : 2.5) * dt
    const fwd = new THREE.Vector3()
    this.camera.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
    fwd.normalize()
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x).negate()
    const delta = new THREE.Vector3()
    if (this.moveKeys.has('w')) delta.add(fwd)
    if (this.moveKeys.has('s')) delta.sub(fwd)
    if (this.moveKeys.has('d')) delta.add(right)
    if (this.moveKeys.has('a')) delta.sub(right)
    if (this.moveKeys.has('r')) delta.y += 1
    if (this.moveKeys.has('f')) delta.y -= 1
    if (delta.lengthSq() === 0) return
    delta.normalize().multiplyScalar(speed)
    // move camera and orbit pivot together so orbiting keeps working from the new spot
    this.camera.position.add(delta)
    this.controls.target.add(delta)
    if (this.controls.target.y < 0.05) {
      const lift = 0.05 - this.controls.target.y
      this.controls.target.y += lift
      this.camera.position.y += lift
    }
  }

  resize(): void {
    const w = window.innerWidth || 1280
    const h = window.innerHeight || 720
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  tick(dt: number): void {
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i]
      c.position.x += dt * 0.12 * (0.5 + (i % 3) * 0.3)
      if (c.position.x > 45) c.position.x = -45
    }
    this.applyFreeMove(dt)
    this.controls.update()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}
