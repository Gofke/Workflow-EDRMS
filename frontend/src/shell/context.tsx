import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export interface RecordContext {
  type: 'ITEM' | 'DOSSIER';
  id: string;
  label: string;
}

interface AssistantState {
  open: boolean;
  setOpen: (v: boolean) => void;
  context: RecordContext | null;
  setContext: (c: RecordContext | null) => void;
  /** A question to put to the assistant when it opens. */
  prompt: string | null;
  ask: (question: string) => void;
  clearPrompt: () => void;
  /** An earlier conversation to show when the assistant opens. */
  resume: string | null;
  openConversation: (id: string) => void;
  clearResume: () => void;
}

const AssistantContext = createContext<AssistantState | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<RecordContext | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [resume, setResume] = useState<string | null>(null);
  const value = useMemo(
    () => ({
      open,
      setOpen,
      context,
      setContext,
      prompt,
      ask: (q: string) => {
        setPrompt(q);
        setOpen(true);
      },
      clearPrompt: () => setPrompt(null),
      resume,
      openConversation: (id: string) => {
        setResume(id);
        setOpen(true);
      },
      clearResume: () => setResume(null),
    }),
    [open, context, prompt, resume],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantState {
  const v = useContext(AssistantContext);
  if (!v) throw new Error('AssistantProvider missing');
  return v;
}

/** A detail page tells the assistant which record is on screen. */
export function useRecordContext(context: RecordContext | null) {
  const { setContext } = useAssistant();
  const key = context ? `${context.type}:${context.id}:${context.label}` : '';
  useEffect(() => {
    setContext(context);
    return () => setContext(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setContext]);
}
