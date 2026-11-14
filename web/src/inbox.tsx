import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { QuestionView } from '../../src/domain/read.ts';
import { useApi } from './use-api.ts';

type InboxState = ReturnType<typeof useApi<QuestionView[]>>;
const InboxContext = createContext<InboxState | null>(null);

/** One pending queue drives both the global counter and the Inbox page. */
export function InboxProvider({ children }: { children: ReactNode }) {
  const questions = useApi<QuestionView[]>('/questions?status=pending', ['questions']);
  return <InboxContext.Provider value={questions}>{children}</InboxContext.Provider>;
}

/** Question cards can also be rendered outside the app shell. */
export function useInbox() { return useContext(InboxContext); }
