import { createContext, useCallback, useContext, useId, useState, type ReactNode } from "react";
import { useDockedPanel } from "../commercial/panel-shared";
import type { DestructiveConfirmSpec } from "../../lib/encounter-void";

/**
 * The one place alert colour appears in the pre-finalization delete (§3): the confirm button of
 * this dialog. A browser-native confirm cannot carry a red button, rename "OK", or put focus on the safe
 * choice, so every clear and every detail-losing remove confirms here instead.
 *
 * `ConfirmDestructiveProvider` mounts once per charting scene. `useConfirmDestructive()` hands a
 * surface `confirm(spec)`, which resolves `true` only when the clinician presses the confirm
 * button. Escape, the backdrop, and Keep all resolve `false`. Outside a provider, the hook refuses
 * the destructive action. Development builds also report the missing provider so the wiring gap
 * is found before release.
 */

export type ConfirmDestructive = (spec: DestructiveConfirmSpec) => Promise<boolean>;

const ConfirmDestructiveContext = createContext<ConfirmDestructive | undefined>(undefined);

interface PendingConfirm {
  spec: DestructiveConfirmSpec;
  resolve: (answer: boolean) => void;
}

export function ConfirmDestructiveProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm>();

  const confirm = useCallback<ConfirmDestructive>((spec) => new Promise<boolean>((resolve) => {
    setPending((current) => {
      // A second request while one is open cannot be answered by the first dialog: refuse it.
      current?.resolve(false);
      return { spec, resolve };
    });
  }), []);

  const settle = useCallback((answer: boolean) => {
    setPending((current) => {
      current?.resolve(answer);
      return undefined;
    });
  }, []);

  return (
    <ConfirmDestructiveContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDestructiveDialog spec={pending.spec} onSettle={settle} />}
    </ConfirmDestructiveContext.Provider>
  );
}

/** A missing provider cannot safely approve a destructive action. */
export const fallbackConfirmDestructive: ConfirmDestructive = async (spec) => {
  if (import.meta.env?.DEV) console.error(`ConfirmDestructiveProvider is missing for: ${spec.title}`);
  return false;
};

export function useConfirmDestructive(): ConfirmDestructive {
  return useContext(ConfirmDestructiveContext) ?? fallbackConfirmDestructive;
}

function ConfirmDestructiveDialog({ spec, onSettle }: { spec: DestructiveConfirmSpec; onSettle: (answer: boolean) => void }) {
  const keep = useCallback(() => onSettle(false), [onSettle]);
  // Escape → Keep; Tab is trapped; focus lands on Keep (the safe choice); focus returns on close.
  const { dialogRef, initialFocusRef, titleId } = useDockedPanel(keep, true, { modal: true });
  const consequenceId = useId();
  return (
    <div
      className="odos-confirm-backdrop"
      data-entry-sheet-pristine-action
      onClick={(event) => { if (event.target === event.currentTarget) keep(); }}
    >
      <section
        ref={dialogRef as React.RefObject<HTMLElement>}
        className="odos-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={consequenceId}
      >
        <div className="odos-confirm-kicker">Please confirm</div>
        <h2 id={titleId}>{spec.title}</h2>
        <p id={consequenceId}>{spec.consequence}</p>
        <div className="odos-confirm-actions">
          <button ref={initialFocusRef} type="button" className="odos-confirm-keep" onClick={keep}>
            Keep
          </button>
          <button type="button" className="odos-confirm-destroy" onClick={() => onSettle(true)}>
            {spec.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
