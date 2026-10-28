/**
 * 表现层：用 Web Audio 合成简单提示音，不依赖音频文件。默认静音。
 * 浏览器要求用户操作后才能出声，所以 AudioContext 在第一次打开声音时才创建。
 */

/** 每种提示音由若干 [频率 Hz, 时长 秒] 组成，依次播放 */
const TONES = {
  dice: [[520, 0.04], [620, 0.04], [720, 0.05]],
  buy: [[523, 0.08], [659, 0.08], [784, 0.14]],
  coin: [[988, 0.06], [1319, 0.12]],
  pay: [[392, 0.1], [330, 0.14]],
  jail: [[262, 0.15], [196, 0.25]],
  win: [[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.3]],
  error: [[160, 0.18]],
};

export function createSound() {
  let ctx = null;
  let muted = true;

  /** @param {keyof typeof TONES} name */
  function play(name) {
    const notes = TONES[name];
    if (muted || !ctx || !notes) return;
    let t = ctx.currentTime;
    for (const [freq, len] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      // 淡入淡出，避免爆音
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len;
    }
  }

  /** @param {boolean} value */
  function setMuted(value) {
    muted = value;
    if (muted) return;
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) {
      muted = true;
      return;
    }
    ctx ??= new AudioCtx();
    ctx.resume();
  }

  return {
    play,
    setMuted,
    get muted() {
      return muted;
    },
  };
}
