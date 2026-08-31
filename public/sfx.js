(() => {
  let context = null;
  const muted = () => {
    try {
      return localStorage.meowdokuMuted === '1';
    } catch {
      return false;
    }
  };
  const initAudio = () => {
    if (context) {
      if (context.state === 'suspended') context.resume().catch(() => {});
      return;
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      context = new AudioContext();
      context.resume().catch(() => {});
    } catch {}
  };
  const muteButton = document.querySelector('#mute-button');
  const updateMuteButton = () => {
    if (muteButton) muteButton.textContent = muted() ? '🔇' : '🔊';
  };
  document.addEventListener('pointerdown', initAudio, { capture: true, once: true });
  updateMuteButton();
  muteButton?.addEventListener('click', () => {
    try {
      localStorage.meowdokuMuted = muted() ? '0' : '1';
      updateMuteButton();
    } catch {}
  });

  const playMeow = now => {
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = 'bandpass'; filter.Q.value = 4;
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(2200, now + 0.12);
    filter.frequency.exponentialRampToValueAtTime(600, now + 0.5);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.04);
    gain.gain.setValueAtTime(0.25, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    filter.connect(gain); gain.connect(context.destination);
    [-12, 12].forEach(detune => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sawtooth'; oscillator.detune.value = detune;
      oscillator.frequency.setValueAtTime(450, now);
      oscillator.frequency.exponentialRampToValueAtTime(700, now + 0.15);
      oscillator.frequency.exponentialRampToValueAtTime(330, now + 0.5);
      oscillator.connect(filter); oscillator.start(now); oscillator.stop(now + 0.55);
    });
  };
  const playTone = (type, start, end, level, decay) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(start.frequency, start.time);
    if (end) oscillator.frequency.exponentialRampToValueAtTime(end.frequency, end.time);
    gain.gain.setValueAtTime(0.001, start.time);
    gain.gain.exponentialRampToValueAtTime(level, start.time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start.time + decay);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(start.time); oscillator.stop(start.time + decay);
  };
  const playSprint = now => {
    playTone('sawtooth', { frequency: 880, time: now }, null, 0.15, 0.15);
    playTone('sawtooth', { frequency: 1175, time: now + 0.15 }, null, 0.15, 0.2);
  };
  window.playSfx = name => {
    try {
      if (muted()) return;
      if (!context) return;
      if (context.state === 'suspended') {
        context.resume().catch(() => {});
        return;
      }
      const now = context.currentTime;
      if (name === 'meow') playMeow(now);
      else if (name === 'wrong') playTone('square', { frequency: 160, time: now }, { frequency: 110, time: now + 0.18 }, 0.15, 0.18);
      else if (name === 'tick') playTone('triangle', { frequency: 1050, time: now }, null, 0.12, 0.06);
      else if (name === 'go') playTone('triangle', { frequency: 600, time: now }, { frequency: 1250, time: now + 0.22 }, 0.2, 0.3);
      else if (name === 'sprint') playSprint(now);
    } catch {}
  };
})();
