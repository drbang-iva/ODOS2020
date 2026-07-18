import { useId, type ReactNode } from "react";

export function ListHeader({
  title,
  searchValue,
  searchPlaceholder = "Search",
  filters,
  newActionLabel,
  onSearchChange,
  onNew,
}: {
  title: string;
  searchValue: string;
  searchPlaceholder?: string;
  filters?: ReactNode;
  newActionLabel?: string;
  onSearchChange: (value: string) => void;
  onNew?: () => void;
}) {
  const searchId = useId();

  return (
    <header className="settings-list-header">
      <div className="settings-list-heading">
        <h2>{title}</h2>
        <label className="settings-list-search" htmlFor={searchId}>
          <span className="sr-only">Search {title}</span>
          <span aria-hidden="true">⌕</span>
          <input
            id={searchId}
            type="search"
            value={searchValue}
            placeholder={searchPlaceholder}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        {filters && <div className="settings-list-filters">{filters}</div>}
      </div>
      {newActionLabel && onNew && (
        <button className="settings-primary-action" type="button" onClick={onNew}>
          {newActionLabel}
        </button>
      )}
    </header>
  );
}
