/** Synthesized glass-and-brass cues. No samples. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastHit = 0;
  private lastGather = 0;

  resume(): void {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!this.ctx) {
      const ctx = new Ctx();
      const master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.ambient(ctx, master);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  select(): void {
    this.tone(860, 0.05, 'sine', 0.08);
    this.tone(1280, 0.04, 'triangle', 0.04);
  }

  command(): void {
    this.tone(440, 0.09, 'triangle', 0.1, 700);
  }

  place(): void {
    this.tone(220, 0.12, 'sine', 0.08, 330);
    this.tone(660, 0.1, 'triangle', 0.05);
  }

  ready(): void {
    this.tone(523, 0.08, 'sine', 0.08);
    this.tone(659, 0.1, 'sine', 0.07);
    this.tone(784, 0.14, 'triangle', 0.06);
  }

  gather(): void {
    const now = performance.now();
    if (now - this.lastGather < 180) return;
    this.lastGather = now;
    this.tone(1400, 0.04, 'sine', 0.04, 1800);
  }

  hit(): void {
    const now = performance.now();
    if (now - this.lastHit < 90) return;
    this.lastHit = now;
    this.noise(0.05, 900, 0.05);
    this.tone(180, 0.06, 'square', 0.03);
  }

  alarm(): void {
    this.tone(320, 0.16, 'sawtooth', 0.06, 180);
    this.tone(480, 0.18, 'triangle', 0.04);
  }

  win(): void {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, 'sine', 0.08, undefined, i * 0.08));
  }

  lose(): void {
    [392, 349, 311, 220].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.07, undefined, i * 0.1));
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slide?: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slide), t + dur);
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(amp);
    amp.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, freq: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const length = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private ambient(ctx: AudioContext, master: GainNode): void {
    const amp = ctx.createGain();
    amp.gain.value = 0.035;
    amp.connect(master);
    for (const freq of [110, 164.8, 220]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = freq === 110 ? 0.4 : 0.18;
      osc.connect(g);
      g.connect(amp);
      osc.start();
    }
  }
}
