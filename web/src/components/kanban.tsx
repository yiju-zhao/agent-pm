import { useId } from 'react';
import type { ProjectCard } from '../../../src/domain/read.ts';
import { isDormant, kanbanColumns } from '../home-model.ts';
import { PriorityTag, projectHref } from './project-card.tsx';

/**
 * The same projects as the list, laid out by stage. A card is only a priority, a title and how long it has slept; the
 * list is where the details are. It is the one part of the page that scrolls sideways.
 */
export function Kanban({ cards }: { cards: ProjectCard[] }) {
  const base = useId();
  return (
    <div className="kanban">
      {kanbanColumns(cards).map((column) => {
        const headingId = `${base}-${column.stage}`;
        return (
          <section key={column.stage} className="kcol" aria-labelledby={headingId}>
            <h3 id={headingId} className="h">{`${column.label} · ${column.cards.length}`}</h3>
            {column.cards.map((card) => {
              const dormant = isDormant(card);
              return (
                <div key={card.id} className={dormant ? 'kcard dormant' : 'kcard'}>
                  <PriorityTag priority={card.priority} />
                  <a href={projectHref(card.id)}>{card.title}</a>
                  {dormant ? <span className="dim">休眠 {card.dormant_days} 天</span> : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
