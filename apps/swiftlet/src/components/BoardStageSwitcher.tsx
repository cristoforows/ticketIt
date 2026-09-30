import { cx, SecondaryButton, statusLabel, statusTone, type TicketStatus } from "./ui";

export interface StageSummary {
  value: TicketStatus;
  label: string;
  count: number;
}

interface BoardStageSwitcherProps {
  stages: StageSummary[];
  current: number;
  onSelect: (index: number) => void;
}

export function BoardStageSwitcher({ stages, current, onSelect }: BoardStageSwitcherProps) {
  const stage = stages[current];
  const previous = stages[current - 1];
  const next = stages[current + 1];
  return (
    <div data-testid="board-stage-switcher" role="group" aria-label="Board stage" {...statusTone(stage.value)} className="mb-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <SecondaryButton
          tone="ground"
          data-testid="board-stage-prev"
          aria-label={previous ? `Previous stage: ${previous.label}` : "Previous stage"}
          disabled={!previous}
          onClick={() => onSelect(current - 1)}
        >
          ◂
        </SecondaryButton>
        <p data-testid="board-stage-current" aria-live="polite" className="m-0 flex items-center gap-2 text-body font-bold tracking-label text-(--status-text) uppercase">
          <span>{stage.label}</span>
          <span aria-label={`${stage.count} orders`}>{stage.count}</span>
        </p>
        <SecondaryButton
          tone="ground"
          data-testid="board-stage-next"
          aria-label={next ? `Next stage: ${next.label}` : "Next stage"}
          disabled={!next}
          onClick={() => onSelect(current + 1)}
        >
          ▸
        </SecondaryButton>
      </div>
      <ol className="m-0 flex list-none gap-1 p-0">
        {stages.map((item, index) => (
          <li key={item.value} className="flex-1">
            <button
              type="button"
              data-testid={`board-stage-step-${item.value}`}
              aria-label={`${statusLabel(item.value)}, ${item.count} orders`}
              aria-current={index === current ? "true" : undefined}
              {...statusTone(item.value)}
              className="flex h-6 w-full items-center border-0 bg-transparent p-0"
              onClick={() => onSelect(index)}
            >
              <span className={cx("block w-full rounded-pill", index === current ? "h-2.5 bg-(--status-text)" : "h-1.5 bg-dim opacity-60")} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
