import * as THREE from 'three'
import { Stage } from './engine/scene'
import { Course } from './course/course'
import { WaterSim, MAX_Q } from './sim/water'
import { ItemSim, FoodKind } from './sim/somen'
import { WaterRender } from './render/water'
import { SplashSystem } from './render/particles'
import { Editor } from './editor/editor'
import { createUI } from './ui'
import { SoundScape } from './audio'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const uiRoot = document.getElementById('ui') as HTMLElement

const stage = new Stage(canvas)
const course = new Course(stage.scene)
const waterSim = new WaterSim()
const itemSim = new ItemSim(stage.scene)
const splash = new SplashSystem(stage.scene)
const waterRender = new WaterRender(stage.scene, stage.sunDir)
const editor = new Editor(course, stage, canvas)
const sound = new SoundScape()

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let playing = true
let speed = 1
let autoSpawn = false
let follow = false
let autoTimer = 2
let simTime = 0

const STEP = 1 / 120
let acc = 0

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const SAVE_KEY = 'nagashi.course'
let saveTimer = 0

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage full/blocked: keep running */ }
}

function persist(): void {
  safeSet(SAVE_KEY, JSON.stringify(course.serialize()))
}

function schedulePersist(): void {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(persist, 1200)
}

function starterCourse(): void {
  course.clear()
  const src = course.add('source', new THREE.Vector3(-2.9, 1.5, -1.1), Math.PI / 3)
  const b1 = course.add('bamboo_2m', new THREE.Vector3(), 0, (5 * Math.PI) / 180)
  const c1 = course.add('curve_r45', new THREE.Vector3(), 0)
  const b2 = course.add('bamboo_2m', new THREE.Vector3(), 0, (5 * Math.PI) / 180)
  const c2 = course.add('curve_l45', new THREE.Vector3(), 0)
  const b3 = course.add('bamboo_1m', new THREE.Vector3(), 0, (8 * Math.PI) / 180)
  course.connect(src, 0, b1)
  course.connect(b1, 0, c1)
  course.connect(c1, 0, b2)
  course.connect(b2, 0, c2)
  course.connect(c2, 0, b3)
  course.touch()
  // bowl under the open end
  const wc = b3.worldChannels[0]
  const end = wc.ch.points[wc.ch.points.length - 1]
  const tan = new THREE.Vector3()
  wc.ch.tanAt(wc.ch.length, tan)
  tan.y = 0
  tan.normalize()
  course.add('goal_bowl', new THREE.Vector3(end.x + tan.x * 0.42, 0, end.z + tan.z * 0.42), 0)
  course.touch()
}

function loadInitial(): void {
  const hash = location.hash
  if (hash.startsWith('#c=')) {
    try {
      const json = JSON.parse(decodeURIComponent(atob(hash.slice(3))))
      // opening a shared course replaces the auto-save: keep a backup of the old one
      const prev = safeGet(SAVE_KEY)
      if (prev) safeSet(`${SAVE_KEY}.backup`, prev)
      course.load(json)
      history.replaceState(null, '', location.pathname)
      return
    } catch { /* fall through */ }
  }
  const saved = safeGet(SAVE_KEY)
  if (saved) {
    try {
      const json = JSON.parse(saved)
      if (json.parts?.length > 0) {
        course.load(json)
        return
      }
    } catch { /* fall through */ }
  }
  starterCourse()
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const ui = createUI(uiRoot, {
  onPalette: (defId) => {
    if (defId) editor.startPlacing(defId)
    else editor.cancelPlacing()
  },
  onPlayPause: () => (playing = !playing),
  onSpeed: (v) => { speed = v },
  onFlow: (v) => { waterSim.sourceFlow = v },
  onSpawnSomen: () => {
    if (!itemSim.spawnSomen(course)) ui.toast('給水口を配置してください')
  },
  onSpawnFood: (kind: FoodKind) => {
    if (!itemSim.spawnFood(course, kind)) ui.toast('給水口を配置してください')
  },
  onAutoToggle: () => (autoSpawn = !autoSpawn),
  onFollowToggle: () => (follow = !follow),
  onSoundToggle: () => sound.toggle(),
  onUndo: () => editor.undo(),
  onRedo: () => editor.redo(),
  onShare: () => {
    const data = btoa(encodeURIComponent(JSON.stringify(course.serialize())))
    const url = `${location.origin}${location.pathname}#c=${data}`
    if (!navigator.clipboard) {
      window.prompt('共有URL（コピーしてください）', url)
      return
    }
    navigator.clipboard.writeText(url).then(
      () => ui.toast('共有URLをコピーしました'),
      () => window.prompt('共有URL（コピーしてください）', url),
    )
  },
  onReset: () => {
    editor.cancelPlacing()
    editor.select(null)
    itemSim.clear()
    starterCourse()
    editor.snapshot()
    ui.toast('リセットしました（⌘Zで戻せます）')
  },
  onScreenshot: () => {
    stage.render()
    canvas.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'nagashi-studio.png'
      a.click()
      URL.revokeObjectURL(a.href)
      ui.toast('スクリーンショットを保存しました')
    })
  },
  onPitch: (v, commit) => {
    editor.setPitch(v)
    if (commit) editor.snapshot()
  },
  onHeight: (v, commit) => {
    editor.setHeight(v)
    if (commit) editor.snapshot()
  },
  onRotate: (d) => editor.rotateSelected(d),
  onDetach: () => editor.detachSelected(),
  onDelete: () => editor.deleteSelected(),
})

editor.onSelect = (p) => ui.setSelected(p)
editor.onPlacingChange = (defId) => ui.setPlacing(defId)
editor.onHistoryChange = (u, r) => ui.setHistory(u, r)
editor.onEdit = () => schedulePersist()
editor.toast = (msg) => ui.toast(msg)

window.addEventListener('beforeunload', persist)

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

loadInitial()
editor.snapshot()
const debugStats = { frames: 0, steps: 0, playing: () => playing, acc: () => acc }
;(window as unknown as Record<string, unknown>).__nagashi = { course, waterSim, itemSim, stage, debugStats, editor }

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

const followTarget = new THREE.Vector3()
let lastT = performance.now()

stage.renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dtReal = Math.min((now - lastT) / 1000, 0.05)
  lastT = now
  frame(dtReal)
})

// manual stepping (used by tests / headless verification)
;(window as unknown as Record<string, unknown>).__nagashiAdvance = (sec: number) => {
  const nSteps = Math.round(sec * 60)
  for (let i = 0; i < nSteps; i++) frame(1 / 60)
}

function frame(dtReal: number): void {
  const dtSim = playing ? dtReal * speed : 0
  simTime += dtSim

  // fixed-step simulation
  debugStats.frames++
  acc += dtSim
  let steps = 0
  while (acc >= STEP && steps < 8) {
    waterSim.update(course, STEP)
    itemSim.step(course)
    acc -= STEP
    steps++
    debugStats.steps++
  }
  if (steps === 8) acc = 0

  // frame-rate visuals
  const bowls = course.bowls()
  waterRender.update(course, waterSim, splash, dtSim, simTime, stage.camera.position)
  splash.update(dtSim, bowls)
  itemSim.sync(dtReal)

  // bowl fill + splash audio from droplet impacts
  if (splash.hits.length > 0) {
    for (const hit of splash.hits) {
      if (hit.bowl) hit.bowl.bowlFill = Math.min(1, hit.bowl.bowlFill + 0.0012)
    }
    sound.splash(Math.min(1, splash.hits.length * 0.06))
  }
  for (let i = 0; i < itemSim.splashes.length; i += 4) {
    const inten = itemSim.splashes[i + 3]
    splash.burst(itemSim.splashes[i], itemSim.splashes[i + 1], itemSim.splashes[i + 2], Math.ceil(inten * 6), 0.3 + inten * 0.5)
    sound.splash(inten)
  }
  itemSim.splashes.length = 0 // consume once; do not replay while paused

  // auto spawn
  if (autoSpawn && playing) {
    autoTimer -= dtSim
    if (autoTimer <= 0) {
      autoTimer = 3.8
      itemSim.spawnSomen(course)
      if (Math.random() < 0.3) {
        const kinds: FoodKind[] = ['tomato', 'ice', 'mikan']
        itemSim.spawnFood(course, kinds[Math.floor(Math.random() * kinds.length)])
      }
    }
  }

  // follow camera
  if (follow && itemSim.followTarget(followTarget)) {
    stage.controls.target.lerp(followTarget, 0.06)
  }

  sound.update(dtReal, waterSim.totalFlow / MAX_Q)
  stage.tick(dtReal)
  stage.render()
}
