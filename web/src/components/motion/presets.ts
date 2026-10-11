import type { Transition, Variants } from "motion/react";

/**
 * Motion tokens. Movement serves information: it signals state changes, arrivals and feedback.
 * Durations stay within 150–350 ms; everything animates transform/opacity only.
 */
export const duration = { fast: 0.15, base: 0.22, slow: 0.35 } as const;

export const ease = {
  standard: [0.2, 0, 0, 1],
  exit: [0.3, 0, 1, 1],
} as const;

export const spring = {
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.7 },
  gentle: { type: "spring", stiffness: 260, damping: 30 },
  layout: { type: "spring", stiffness: 420, damping: 40 },
} satisfies Record<string, Transition>;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.standard } },
  exit: { opacity: 0, y: -4, transition: { duration: duration.fast, ease: ease.exit } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.base, ease: ease.standard } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.exit } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.98, transition: { duration: duration.fast, ease: ease.exit } },
};

/** Parent variant that staggers its children's "visible" state (lists, grids). */
export function staggerChildren(stagger = 0.035, delayChildren = 0): Variants {
  return {
    hidden: {},
    visible: { transition: { staggerChildren: stagger, delayChildren } },
    exit: {},
  };
}

export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.standard } },
  exit: { opacity: 0, x: -8, transition: { duration: duration.fast, ease: ease.exit } },
};
