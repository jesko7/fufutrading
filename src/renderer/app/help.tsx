import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { Modal, openModal, Spinner } from '../components/ui';
import { Markdown } from '../modules/ai/markdown';

export const DOCS: { id: string; title: string }[] = [
  { id: 'trading', title: 'Paper trading, futures, prop challenges and bots' },
  { id: 'backtesting', title: 'Backtesting and optimization' },
  { id: 'pine', title: 'Pine Script support' },
  { id: 'pine-reference', title: 'Pine Script built-ins (reference)' },
  { id: 'python', title: 'Python scripting API' },
  { id: 'replay-alerts-data', title: 'Replay, alerts, market data and the AI assistant' },
];

/** Open a documentation page in a modal. */
export function openDoc(id: string): void {
  openModal(`doc-${id}`, (close) => <DocModal id={id} onClose={close} />);
}

function DocModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api
      .call<string>('docs:get', id)
      .then((t) => setText(id === 'pine-reference' ? t.replace(/^(\w[\w.]*\(.*\))$/gm, '- `$1`') : t))
      .catch((e) => setErr(errorMessage(e)));
  }, [id]);
  const title = DOCS.find((d) => d.id === id)?.title || 'Documentation';
  return (
    <Modal title={title} icon="notebook" onClose={onClose} width={760}>
      <div className="doc-body">
        {err ? <div className="danger-text">{err}</div> : text === null ? <Spinner /> : <Markdown text={text} />}
      </div>
    </Modal>
  );
}
