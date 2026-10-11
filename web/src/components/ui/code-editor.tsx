import { json, jsonParseLinter } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type Extension } from "@uiw/react-codemirror";
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { useField } from "./field";

/** Editor colours come from the design tokens, so light and dark themes follow automatically. */
const tokens = EditorView.theme({
  "&": {
    color: "var(--gv-ink)",
    backgroundColor: "var(--gv-surface)",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    caretColor: "var(--gv-brand)",
    padding: "10px 0",
  },
  ".cm-gutters": {
    backgroundColor: "var(--gv-surface-2)",
    color: "var(--gv-muted)",
    border: "none",
    borderRight: "1px solid var(--gv-line)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--gv-brand) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--gv-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--gv-brand) 22%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--gv-brand)" },
  ".cm-tooltip": {
    backgroundColor: "var(--gv-surface)",
    color: "var(--gv-ink)",
    border: "1px solid var(--gv-line)",
    borderRadius: "6px",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--gv-danger)",
  },
});

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.string, color: "var(--gv-success-text)" },
    { tag: tags.number, color: "var(--gv-brand-text)" },
    { tag: [tags.bool, tags.null], color: "var(--gv-warning-text)" },
    { tag: tags.propertyName, color: "var(--gv-ink)", fontWeight: "500" },
    { tag: [tags.punctuation, tags.bracket], color: "var(--gv-muted)" },
  ]),
);

type CodeEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  language?: "json" | "text";
  readOnly?: boolean;
  minHeight?: string;
  maxHeight?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

/**
 * Accessible code editor (CodeMirror 6): keyboard-first, labelled through the surrounding
 * <Field>, JSON linting inline. Tab moves focus out unless the user enters indentation mode.
 */
export function CodeEditor({
  value,
  onChange,
  language = "json",
  readOnly = false,
  minHeight = "120px",
  maxHeight = "420px",
  className,
  id,
  ...aria
}: CodeEditorProps) {
  const field = useField();
  const controlId = id ?? field?.id;
  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [
      tokens,
      highlight,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        ...(controlId ? { id: controlId } : {}),
        ...(aria["aria-label"] ? { "aria-label": aria["aria-label"] } : {}),
        ...(aria["aria-describedby"] ? { "aria-describedby": aria["aria-describedby"] } : {}),
        ...(aria["aria-invalid"] ? { "aria-invalid": "true" } : {}),
        "aria-multiline": "true",
      }),
    ];
    if (language === "json") {
      list.push(json());
      if (!readOnly) list.push(linter(jsonParseLinter(), { delay: 300 }), lintGutter());
    }
    return list;
  }, [language, readOnly, controlId, aria]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-field border border-line-strong/70 shadow-sm transition-[border-color,box-shadow]",
        "focus-within:border-brand focus-within:shadow-glow",
        aria["aria-invalid"] && "border-danger",
        readOnly && "bg-surface-2",
        className,
      )}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        theme="none"
        minHeight={minHeight}
        maxHeight={maxHeight}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
          searchKeymap: false,
          syntaxHighlighting: false,
          tabSize: 2,
        }}
      />
    </div>
  );
}
