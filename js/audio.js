// 効果音（Web Audio で合成。音声ファイルは使わない）
// 吸引中: 水のボコボコ音 + 空気の流れる音。吸う強さで泡の頻度と音量が変わる。
export class Sfx {
  constructor() { this.ctx = null; this.nextBubble = 0; this.warned = false; }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(ctx.destination);
    // 空気音: ノイズ → バンドパス
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    this.hissFilter = ctx.createBiquadFilter(); this.hissFilter.type = 'bandpass'; this.hissFilter.frequency.value = 700; this.hissFilter.Q.value = 0.7;
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    src.connect(this.hissFilter).connect(this.hissGain).connect(this.master);
    src.start();
  }

  bubble(strength) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    const f0 = 140 + Math.random() * 260, dur = 0.05 + Math.random() * 0.07;
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.6 + Math.random() * 0.8), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10 + 0.25 * strength * Math.random(), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  tone(freq, dur, vol, type = 'sine') {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  click() { this.tone(880, 0.06, 0.08, 'triangle'); }

  // 毎フレーム呼ぶ。lpm: 吸引流量、enabled: 効果音オン、scorch: 過熱状態
  update(lpm, enabled, scorch) {
    this.enabled = enabled;
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = enabled ? Math.min(1, lpm / 20) : 0;
    this.hissGain.gain.setTargetAtTime(s * 0.22, t, 0.05);
    this.hissFilter.frequency.setTargetAtTime(450 + 900 * s, t, 0.05);
    if (s > 0 && t >= this.nextBubble) {
      this.bubble(s);
      this.nextBubble = t + (0.03 + Math.random() * 0.09) / (0.35 + s);
    }
    if (scorch && !this.warned && enabled) { this.tone(220, 0.35, 0.15, 'sawtooth'); setTimeout(() => this.tone(165, 0.45, 0.15, 'sawtooth'), 180); }
    this.warned = scorch;
  }
}
