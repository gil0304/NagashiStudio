/** Procedural summer soundscape: flowing-water noise, splash blips, a wind chime. */
export class SoundScape {
  enabled = false
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private waterGain: GainNode | null = null
  private splashCooldown = 0
  private chimeTimer = 8

  private ensure(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0.55
    this.master.connect(ctx.destination)

    // looping noise -> bandpass stack = brook
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1
      last = (last + 0.04 * white) / 1.04 // brown-ish
      data[i] = last * 4
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const bp1 = ctx.createBiquadFilter()
    bp1.type = 'bandpass'
    bp1.frequency.value = 900
    bp1.Q.value = 0.6
    const bp2 = ctx.createBiquadFilter()
    bp2.type = 'highpass'
    bp2.frequency.value = 350
    this.waterGain = ctx.createGain()
    this.waterGain.gain.value = 0
    src.connect(bp1).connect(bp2).connect(this.waterGain).connect(this.master)
    src.start()
  }

  toggle(): boolean {
    this.enabled = !this.enabled
    if (this.enabled) {
      this.ensure()
      this.ctx?.resume()
    }
    return this.enabled
  }

  /** flow: 0..1 overall water activity */
  update(dt: number, flow: number): void {
    if (!this.ctx || !this.waterGain) return
    const target = this.enabled ? Math.min(0.5, flow * 0.7) : 0
    const g = this.waterGain.gain
    g.value += (target - g.value) * Math.min(1, dt * 3)
    this.splashCooldown = Math.max(0, this.splashCooldown - dt)

    this.chimeTimer -= dt
    if (this.chimeTimer <= 0) {
      this.chimeTimer = 14 + Math.random() * 26
      if (this.enabled) this.chime()
    }
  }

  splash(intensity: number): void {
    if (!this.enabled || !this.ctx || !this.master || this.splashCooldown > 0) return
    this.splashCooldown = 0.09
    const ctx = this.ctx
    const dur = 0.12 + intensity * 0.1
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 1400 + Math.random() * 1200
    f.Q.value = 1
    const g = ctx.createGain()
    g.gain.value = 0.1 + intensity * 0.25
    src.connect(f).connect(g).connect(this.master)
    src.start()
  }

  private chime(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const freq = 1760 * (Math.random() < 0.5 ? 1 : 1.19)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const mod = ctx.createOscillator()
    mod.frequency.value = freq * 2.76
    const modGain = ctx.createGain()
    modGain.gain.value = 240
    mod.connect(modGain).connect(osc.frequency)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8)
    osc.connect(g).connect(this.master)
    osc.start(t0)
    mod.start(t0)
    osc.stop(t0 + 3)
    mod.stop(t0 + 3)
  }
}
