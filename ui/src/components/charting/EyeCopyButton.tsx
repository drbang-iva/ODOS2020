type Eye = "OD" | "OS";

export function EyeCopyButton({ eye, onCopy }: { eye: Eye; onCopy(): void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded border border-white/15 px-2 py-1 text-xs text-white/55 hover:text-white"
    >
      {eye === "OD" ? "Copy to OS →" : "← Copy to OD"}
    </button>
  );
}
