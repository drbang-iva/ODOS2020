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
      className="rounded border border-[color:var(--odos-line)] px-2 py-1 text-xs text-[color:var(--odos-muted)] hover:text-[color:var(--odos-text)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {eye === "OD" ? "Copy to OS →" : "← Copy to OD"}
    </button>
  );
}
