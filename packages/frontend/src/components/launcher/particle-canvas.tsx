'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from '../../providers/theme-provider';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
}

const PARTICLE_COUNT = 80;
const CONNECTION_DISTANCE = 180;
const SPEED_RANGE = 0.32;

const COLORS = {
  light: { r: 73, g: 114, b: 222 },  // arbitra-400 #4972de
  dark: { r: 133, g: 168, b: 248 },  // arbitra-300 #85a8f8
};

function createParticle(width: number, height: number): Particle {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 2 * SPEED_RANGE,
    vy: (Math.random() - 0.5) * 2 * SPEED_RANGE,
    radius: 2 + Math.random() * 2.5,
    opacity: 0.36 + Math.random() * 0.36,
  };
}

export function ParticleCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number>(0);
  const { theme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Check reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas!.getBoundingClientRect();
      canvas!.width = rect.width * dpr;
      canvas!.height = rect.height * dpr;
      ctx!.scale(dpr, dpr);
    }

    resize();
    window.addEventListener('resize', resize);

    // Initialize particles
    const rect = canvas.getBoundingClientRect();
    if (particlesRef.current.length === 0) {
      particlesRef.current = Array.from({ length: PARTICLE_COUNT }, () =>
        createParticle(rect.width, rect.height),
      );
    }

    function draw() {
      const rect = canvas!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx!.clearRect(0, 0, w, h);

      const color = theme === 'dark' ? COLORS.dark : COLORS.light;
      const particles = particlesRef.current;

      // Update positions (skip if reduced motion)
      if (!prefersReducedMotion) {
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;

          // Wrap around edges
          if (p.x < 0) p.x = w;
          if (p.x > w) p.x = 0;
          if (p.y < 0) p.y = h;
          if (p.y > h) p.y = 0;
        }
      }

      // Draw connection lines
      for (let i = 0; i < particles.length; i++) {
        const pi = particles[i]!;
        for (let j = i + 1; j < particles.length; j++) {
          const pj = particles[j]!;
          const dx = pi.x - pj.x;
          const dy = pi.y - pj.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECTION_DISTANCE) {
            const lineOpacity = (1 - dist / CONNECTION_DISTANCE) * 0.27;
            ctx!.beginPath();
            ctx!.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${lineOpacity})`;
            ctx!.lineWidth = 0.8;
            ctx!.moveTo(pi.x, pi.y);
            ctx!.lineTo(pj.x, pj.y);
            ctx!.stroke();
          }
        }
      }

      // Draw particles
      for (const p of particles) {
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${p.opacity})`;
        ctx!.fill();
      }

      if (active) {
        animFrameRef.current = requestAnimationFrame(draw);
      }
    }

    if (active) {
      animFrameRef.current = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [active, theme]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      aria-hidden="true"
    />
  );
}
