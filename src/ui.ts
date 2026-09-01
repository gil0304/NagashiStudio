import { PartInstance } from './course/course'
import { PART_DEFS } from './parts/defs'
import { FoodKind } from './sim/somen'

export interface UIHandlers {
  onPalette(defId: string | null): void
  onPlayPause(): boolean
  onSpeed(v: number): void
  onFlow(v: number): void
  onSpawnSomen(): void
  onSpawnFood(kind: FoodKind): void
  onAutoToggle(): boolean
  onFollowToggle(): boolean
  onSoundToggle(): boolean
  onUndo(): void
  onRedo(): void
  onShare(): void
  onReset(): void
  onScreenshot(): void
  onPitch(v: number, commit: boolean): void
  onHeight(v: number, commit: boolean): void
  onRotate(d: number): void
  onDetach(): void
  onDelete(): void
}

export interface UIApi {
  setSelected(part: PartInstance | null): void
  setPlacing(defId: string | null): void
  setHistory(u: boolean, r: boolean): void
  toast(msg: string): void
  hint(msg: string | null): void
}

const DEG = 180 / Math.PI

export function createUI(root: HTMLElement, h: UIHandlers): UIApi {
  root.innerHTML = ''

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }
  const btn = (label: string, cls: string, onClick: (b: HTMLButtonElement) => void, title?: string): HTMLButtonElement => {
    const b = el('button', cls, label) as HTMLButtonElement
    if (title) b.title = title
    b.addEventListener('click', () => onClick(b))
    return b
  }

  // ---- top bar ----
  const top = el('div', 'panel')
  top.id = 'topbar'
  const title = el('span', 'title', 'NAGASHI STUDIO')
  const sub = el('small', '', '流しそうめん3Dシミュレーター')
  title.appendChild(sub)
  const undoBtn = btn('↩', 'icon', () => h.onUndo(), '元に戻す (⌘Z)')
  const redoBtn = btn('↪', 'icon', () => h.onRedo(), 'やり直す (⇧⌘Z)')
  undoBtn.disabled = true
  redoBtn.disabled = true
  const shareBtn = btn('共有URL', '', () => h.onShare(), 'コースを共有URLとしてコピー')
  const shotBtn = btn('📷', 'icon', () => h.onScreenshot(), 'スクリーンショットを保存')
  const soundBtn = btn('🔇', 'icon', (b) => { b.textContent = h.onSoundToggle() ? '🔊' : '🔇' }, '環境音')
  const resetBtn = btn('リセット', 'danger', () => h.onReset(), '最初のコースに戻す')
  const helpBtn = btn('？', 'icon', () => help.classList.add('visible'), '操作説明')
  top.append(title, undoBtn, redoBtn, shareBtn, shotBtn, soundBtn, resetBtn, helpBtn)

  // ---- palette ----
  const pal = el('div', 'panel')
  pal.id = 'palette'
  const palButtons = new Map<string, HTMLButtonElement>()
  let currentCat = ''
  for (const def of PART_DEFS) {
    if (def.category !== currentCat) {
      currentCat = def.category
      pal.appendChild(el('div', 'cat', currentCat))
    }
    const b = el('button') as HTMLButtonElement
    const ico = el('span', 'ico', def.icon)
    b.append(ico, document.createTextNode(def.label))
    b.addEventListener('click', () => {
      const active = b.classList.contains('active')
      h.onPalette(active ? null : def.id)
    })
    palButtons.set(def.id, b)
    pal.appendChild(b)
  }

  // ---- bottom bar ----
  const bottom = el('div', 'panel')
  bottom.id = 'bottombar'
  const playBtn = btn('⏸', 'icon', (b) => { b.textContent = h.onPlayPause() ? '⏸' : '▶' }, '再生 / 一時停止')
  const speedSel = el('select') as HTMLSelectElement
  for (const [v, label] of [['0.25', '0.25×'], ['0.5', '0.5×'], ['1', '1×'], ['2', '2×']]) {
    const o = el('option', '', label) as HTMLOptionElement
    o.value = v
    speedSel.appendChild(o)
  }
  speedSel.value = '1'
  speedSel.addEventListener('change', () => h.onSpeed(parseFloat(speedSel.value)))

  const flowLabel = el('span', 'label-s', '水量')
  const flow = el('input') as HTMLInputElement
  flow.type = 'range'
  flow.min = '0'
  flow.max = '1'
  flow.step = '0.01'
  flow.value = '0.6'
  flow.addEventListener('input', () => h.onFlow(parseFloat(flow.value)))

  const somenBtn = btn('そうめん投入', '', () => h.onSpawnSomen())
  const tomatoBtn = btn('🍅', 'icon', () => h.onSpawnFood('tomato'), 'ミニトマト')
  const iceBtn = btn('🧊', 'icon', () => h.onSpawnFood('ice'), '氷')
  const mikanBtn = btn('🍊', 'icon', () => h.onSpawnFood('mikan'), 'みかん')
  const autoBtn = btn('自動投入', '', (b) => b.classList.toggle('active', h.onAutoToggle()))
  const followBtn = btn('追跡カメラ', '', (b) => b.classList.toggle('active', h.onFollowToggle()))

  const sep = () => el('div', 'sep')
  const grp = (...items: HTMLElement[]) => {
    const g = el('div', 'group')
    g.append(...items)
    return g
  }
  bottom.append(
    grp(playBtn, speedSel), sep(),
    grp(flowLabel, flow), sep(),
    grp(somenBtn, tomatoBtn, iceBtn, mikanBtn, autoBtn), sep(),
    grp(followBtn),
  )

  // ---- inspector ----
  const insp = el('div', 'panel')
  insp.id = 'inspector'
  const inspTitle = el('h3', '', '')
  const pitchRow = el('div', 'row')
  const pitchLabel = el('label', '', '勾配')
  const pitchInput = el('input') as HTMLInputElement
  pitchInput.type = 'range'
  pitchInput.min = '0.5'
  pitchInput.max = '14'
  pitchInput.step = '0.5'
  const pitchOut = el('output', '', '')
  pitchInput.addEventListener('input', () => {
    pitchOut.textContent = `${pitchInput.value}°`
    h.onPitch(parseFloat(pitchInput.value) / DEG, false)
  })
  pitchInput.addEventListener('change', () => h.onPitch(parseFloat(pitchInput.value) / DEG, true))
  pitchRow.append(pitchLabel, pitchInput, pitchOut)

  const heightRow = el('div', 'row')
  const heightLabel = el('label', '', '高さ')
  const heightInput = el('input') as HTMLInputElement
  heightInput.type = 'range'
  heightInput.min = '0.3'
  heightInput.max = '2.2'
  heightInput.step = '0.01'
  const heightOut = el('output', '', '')
  heightInput.addEventListener('input', () => {
    heightOut.textContent = `${parseFloat(heightInput.value).toFixed(2)}m`
    h.onHeight(parseFloat(heightInput.value), false)
  })
  heightInput.addEventListener('change', () => h.onHeight(parseFloat(heightInput.value), true))
  heightRow.append(heightLabel, heightInput, heightOut)

  const rotRow = el('div', 'row')
  rotRow.append(
    el('label', '', '回転'),
    btn('⟲ 15°', '', () => h.onRotate(Math.PI / 12)),
    btn('⟳ 15°', '', () => h.onRotate(-Math.PI / 12)),
  )

  const actRow = el('div', 'row')
  const detachBtn = btn('切り離す', '', () => h.onDetach())
  const delBtn = btn('削除', 'danger', () => h.onDelete())
  actRow.append(detachBtn, delBtn)

  insp.append(inspTitle, pitchRow, heightRow, rotRow, actRow)

  // ---- hint / toast / help ----
  const hint = el('div', 'panel')
  hint.id = 'hint'
  const toastEl = el('div', 'panel')
  toastEl.id = 'toast'
  let toastTimer = 0

  const help = el('div')
  help.id = 'help'
  const card = el('div', 'panel card')
  card.innerHTML = `
    <h2>NAGASHI STUDIO の使い方</h2>
    左のパレットからパーツを選び、地面をクリックして配置。<br>
    竹の端の近くに置くと <b>自動で接続</b> されます。<br>
    <span class="key">ドラッグ</span> 起点パーツの移動（近づけると接続）<br>
    <span class="key">Q</span><span class="key">E</span> 回転 ／ <span class="key">Del</span> 削除 ／ <span class="key">⌘Z</span> 元に戻す<br>
    <span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> カメラ移動 ／ <span class="key">R</span><span class="key">F</span> 上下 ／ <span class="key">Shift</span> 加速<br>
    パーツをクリックすると <b>勾配・高さ</b> を調整できます。<br>
    水量スライダーで流量を変え、そうめんや食材を投入して観察しましょう。
  `
  const closeBtn = btn('はじめる', 'close', () => help.classList.remove('visible'))
  card.appendChild(closeBtn)
  help.appendChild(card)
  help.addEventListener('click', (e) => { if (e.target === help) help.classList.remove('visible') })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && help.classList.contains('visible')) {
      e.stopPropagation()
      help.classList.remove('visible')
    }
  }, true)

  root.append(top, pal, bottom, insp, hint, toastEl, help)

  try {
    if (!localStorage.getItem('nagashi.helpSeen')) {
      help.classList.add('visible')
      localStorage.setItem('nagashi.helpSeen', '1')
    }
  } catch {
    help.classList.add('visible')
  }

  // ---- api ----
  return {
    setSelected(part) {
      if (!part) {
        insp.classList.remove('visible')
        return
      }
      insp.classList.add('visible')
      inspTitle.textContent = part.def.label
      const isRoot = !part.parent
      pitchRow.style.display = part.def.hasPitch ? '' : 'none'
      pitchInput.value = String(Math.round(part.pitch * DEG * 2) / 2)
      pitchOut.textContent = `${(part.pitch * DEG).toFixed(1)}°`
      heightRow.style.display = isRoot && !part.def.isGoal ? '' : 'none'
      heightInput.value = String(part.pos.y)
      heightOut.textContent = `${part.pos.y.toFixed(2)}m`
      rotRow.style.display = isRoot ? '' : 'none'
      detachBtn.style.display = part.parent ? '' : 'none'
    },
    setPlacing(defId) {
      for (const [id, b] of palButtons) b.classList.toggle('active', id === defId)
      hint.classList.toggle('visible', defId !== null)
      if (defId) hint.textContent = 'クリックで配置 ／ Q・E で回転 ／ 右クリックで終了'
    },
    setHistory(u, r) {
      undoBtn.disabled = !u
      redoBtn.disabled = !r
    },
    toast(msg) {
      toastEl.textContent = msg
      toastEl.classList.add('visible')
      clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => toastEl.classList.remove('visible'), 2200)
    },
    hint(msg) {
      if (msg) {
        hint.textContent = msg
        hint.classList.add('visible')
      } else {
        hint.classList.remove('visible')
      }
    },
  }
}
