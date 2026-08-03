type Eye = "OD" | "OS";

export function EyeCopyButton({ eye, onCopy, disabled = false, title }: {
  eye: Eye;
  onCopy(): void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={disabled}
      title={title}
      className="rounded border border-white/15 px-2 py-1 text-xs text-white/55 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
    >
      {eye === "OD" ? "Copy to OS →" : "← Copy to OD"}
    </button>
  );
}
