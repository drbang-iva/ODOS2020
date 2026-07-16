import { useId, useState } from "react";

export type DeleteConfirmationMode =
  | { type: "simple" }
  | { type: "typed"; text: string };

export function ConfirmDelete({
  actionLabel = "Delete",
  confirmLabel = actionLabel,
  title,
  consequence,
  confirmationMode = { type: "simple" },
  disabled = false,
  onConfirm,
}: {
  actionLabel?: string;
  confirmLabel?: string;
  title: string;
  consequence: string;
  confirmationMode?: DeleteConfirmationMode;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const titleId = useId();
  const consequenceId = useId();
  const [open, setOpen] = useState(false);
  const [typedValue, setTypedValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const typedMatch = confirmationMode.type === "simple" || typedValue === confirmationMode.text;

  function close() {
    if (confirming) return;
    setOpen(false);
    setTypedValue("");
  }

  async function confirm() {
    if (!typedMatch) return;
    setConfirming(true);
    try {
      await onConfirm();
      setOpen(false);
      setTypedValue("");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <button
        className="scheduler-button settings-destructive-action"
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {actionLabel}
      </button>
      {open && (
        <div className="settings-confirm-backdrop">
          <section
            className="settings-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={consequenceId}
          >
            <div className="settings-confirm-kicker">Please confirm</div>
            <h2 id={titleId}>{title}</h2>
            <p id={consequenceId}>{consequence}</p>
            {confirmationMode.type === "typed" && (
              <label>
                Type <strong>{confirmationMode.text}</strong> to continue
                <input
                  autoFocus
                  value={typedValue}
                  onChange={(event) => setTypedValue(event.target.value)}
                />
              </label>
            )}
            <footer>
              <button className="scheduler-button" type="button" disabled={confirming} onClick={close}>
                Cancel
              </button>
              <button
                className="scheduler-button settings-destructive-action"
                type="button"
                disabled={confirming || !typedMatch}
                onClick={() => void confirm()}
              >
                {confirmLabel}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
