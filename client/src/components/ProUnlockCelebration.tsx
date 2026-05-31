import React, { useState, useEffect, useMemo } from "react";

// Subtle gold particles drifting up — 24 total, sparse, soft.
function Particles({ active }: { active: boolean }) {
  const parts = useMemo(() => {
    const seed = (i: number) => {
      const x = Math.sin(i * 9301 + 49297) * 233280;
      return x - Math.floor(x);
    };
    return Array.from({ length: 22 }, (_, i) => ({
      x: 6 + seed(i) * 88,
      delay: 0.8 + seed(i + 100) * 1.6,
      dur: 2.6 + seed(i + 200) * 1.4,
      size: 2 + seed(i + 300) * 3,
      drift: (seed(i + 400) - 0.5) * 30,
      blur: seed(i + 500) > 0.6,
    }));
  }, []);
  return (
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
      opacity: active ? 1 : 0, transition: 'opacity 400ms',
    }}>
      {parts.map((p, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${p.x}%`, bottom: -10,
          width: p.size, height: p.size, borderRadius: p.size,
          background: '#e8d5a3',
          boxShadow: '0 0 6px rgba(232,213,163,0.9), 0 0 14px rgba(201,168,76,0.5)',
          filter: p.blur ? 'blur(0.6px)' : 'none',
          opacity: 0,
          animation: active ? `particleRise ${p.dur}s ${p.delay}s cubic-bezier(.3,.1,.3,1) forwards` : 'none',
          '--drift': `${p.drift}px`,
        } as React.CSSProperties}/>
      ))}
    </div>
  );
}

function Celebration({ playing, onComplete }: { playing: boolean; onComplete?: () => void }) {
  // Timeline (ms):
  //   0    dim/blur on
  //   200  radial glow blooms
  //   500  gold ring scales in
  //   700  D mark stroke draws
  //   1400 light sweep (left→right)
  //   1700 particles begin
  //   2100 PRO wordmark fades in
  //   2400 hairline rule draws
  //   3200 mark/wordmark exits up, theme cascade begins
  //   4200 done
  const [stage, setStage] = useState(-1); // -1 idle, 0..N progressing

  useEffect(() => {
    if (!playing) { setStage(-1); return; }
    setStage(0);
    const timers = [
      setTimeout(() => setStage(1), 50),
      setTimeout(() => setStage(2), 3200),
      setTimeout(() => { setStage(3); onComplete && onComplete(); }, 4200),
    ];
    return () => timers.forEach(clearTimeout);
  }, [playing]);

  if (stage < 0) return null;
  const exiting = stage >= 2;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      pointerEvents: 'none',
    }}>
      {/* Dark veil — dims app, slight desaturate */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at center, rgba(10,15,30,0.55) 0%, rgba(10,15,30,0.85) 60%, rgba(10,15,30,0.95) 100%)',
        backdropFilter: 'blur(8px) saturate(0.7)',
        WebkitBackdropFilter: 'blur(8px) saturate(0.7)',
        opacity: stage >= 1 && !exiting ? 1 : 0,
        transition: exiting ? 'opacity 900ms ease 100ms' : 'opacity 500ms ease',
      }}/>

      {/* Soft radial gold glow */}
      <div style={{
        position: 'absolute', left: '50%', top: '46%', transform: 'translate(-50%, -50%)',
        width: 540, height: 540, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(201,168,76,0.35) 0%, rgba(201,168,76,0.12) 35%, rgba(201,168,76,0) 65%)',
        opacity: stage >= 1 && !exiting ? 1 : 0,
        animation: stage >= 1 && !exiting ? 'glowPulse 3s ease-in-out 0.2s both' : 'none',
        transition: exiting ? 'opacity 800ms ease' : 'none',
      }}/>

      {/* Light sweep across screen */}
      {stage >= 1 && !exiting && (
        <div style={{
          position: 'absolute', inset: 0, overflow: 'hidden',
          mixBlendMode: 'screen',
        }}>
          <div style={{
            position: 'absolute', top: 0, bottom: 0, left: 0,
            width: '40%',
            background: 'linear-gradient(105deg, transparent 0%, rgba(232,213,163,0.0) 30%, rgba(232,213,163,0.45) 50%, rgba(232,213,163,0) 70%, transparent 100%)',
            animation: 'sweep 1.4s cubic-bezier(.4,.05,.4,1) 1.4s both',
          }}/>
        </div>
      )}

      {/* Particles */}
      <Particles active={stage >= 1 && !exiting}/>

      {/* Centerpiece: ring + D mark + PRO + rule */}
      <div style={{
        position: 'absolute', left: '50%', top: '46%',
        transform: `translate(-50%, -50%) ${exiting ? 'translateY(-30px)' : ''}`,
        opacity: exiting ? 0 : 1,
        transition: exiting ? 'all 900ms cubic-bezier(.4,0,.2,1)' : 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        {/* Ring + D */}
        <div style={{ position: 'relative', width: 124, height: 124 }}>
          {/* Outer ring */}
          <svg width="124" height="124" viewBox="0 0 124 124" style={{ position: 'absolute', inset: 0 }}>
            <defs>
              <linearGradient id="goldRing" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#e8d5a3"/>
                <stop offset="50%" stopColor="#c9a84c"/>
                <stop offset="100%" stopColor="#8a6f24"/>
              </linearGradient>
              <filter id="ringGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3"/>
              </filter>
            </defs>
            <circle cx="62" cy="62" r="58" fill="none" stroke="url(#goldRing)" strokeWidth="1.5"
              strokeDasharray="365" strokeDashoffset="365"
              style={{ animation: stage >= 1 ? 'ringDraw 1.2s cubic-bezier(.5,.05,.2,1) 0.5s forwards' : 'none' }}/>
            <circle cx="62" cy="62" r="58" fill="none" stroke="url(#goldRing)" strokeWidth="0.5" opacity={0.5} filter="url(#ringGlow)"
              strokeDasharray="365" strokeDashoffset="365"
              style={{ animation: stage >= 1 ? 'ringDraw 1.2s cubic-bezier(.5,.05,.2,1) 0.5s forwards' : 'none' }}/>
          </svg>

          {/* D monogram */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0,
            animation: stage >= 1 ? 'markIn 700ms cubic-bezier(.2,.8,.2,1) 0.9s forwards' : 'none',
          }}>
            <svg width="60" height="60" viewBox="0 0 60 60">
              <defs>
                <linearGradient id="goldFill" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#f0dfb0"/>
                  <stop offset="50%" stopColor="#c9a84c"/>
                  <stop offset="100%" stopColor="#9a7a30"/>
                </linearGradient>
              </defs>
              <path d="M14 10 L14 50 L30 50 Q48 50 48 30 Q48 10 30 10 Z M22 18 L30 18 Q40 18 40 30 Q40 42 30 42 L22 42 Z"
                fill="url(#goldFill)"/>
            </svg>
          </div>

          {/* Inner subtle highlight */}
          <div style={{
            position: 'absolute', inset: 4, borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 30%, rgba(232,213,163,0.15), transparent 50%)',
            opacity: stage >= 1 ? 1 : 0,
            transition: 'opacity 1.2s 1s',
          }}/>
        </div>

        {/* Hairline rule */}
        <div style={{
          width: 90, height: 1, marginTop: 22,
          background: 'linear-gradient(90deg, transparent, #c9a84c, transparent)',
          transform: 'scaleX(0)',
          animation: stage >= 1 ? 'ruleDraw 700ms cubic-bezier(.4,0,.2,1) 2.4s forwards' : 'none',
        }}/>

        {/* PRO wordmark */}
        <div style={{
          marginTop: 16,
          fontFamily: '-apple-system, "SF Pro Display", system-ui',
          fontSize: 13, fontWeight: 600, letterSpacing: 8,
          color: '#e8d5a3',
          opacity: 0,
          animation: stage >= 1 ? 'proIn 800ms cubic-bezier(.2,.7,.2,1) 2.1s forwards' : 'none',
          textShadow: '0 0 20px rgba(201,168,76,0.5)',
        }}>PRO UNLOCKED</div>

        {/* Subtitle */}
        <div style={{
          marginTop: 10,
          fontFamily: '-apple-system, system-ui',
          fontSize: 12, fontWeight: 400, letterSpacing: 0.2,
          color: 'rgba(232,213,163,0.65)',
          opacity: 0,
          animation: stage >= 1 ? 'proIn 800ms cubic-bezier(.2,.7,.2,1) 2.5s forwards' : 'none',
        }}>Welcome to Docera Pro</div>
      </div>

      {/* Theme cascade reveal — gold horizontal line that descends as theme transitions in */}
    </div>
  );
}

export default Celebration;
