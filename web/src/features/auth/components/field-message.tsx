import { CircleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { duration, ease } from "@/components/motion/presets";

/** Error line for custom controls that can't use <Field> (checkbox rows…), same look and motion. */
export function FieldMessage({ id, message }: { id: string; message: string | undefined }) {
  return (
    <AnimatePresence initial={false}>
      {message ? (
        <motion.p
          key="error"
          id={id}
          role="alert"
          className="flex items-start gap-1.5 text-[13px] text-danger-text"
          initial={{ opacity: 0, y: -4 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: { duration: duration.fast, ease: ease.standard },
          }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
        >
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{message}</span>
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}
