/**
 * Strategy from a transcript: paste or load the transcript of a trading video, podcast or
 * course; Sonnet 5.5 at low effort writes down the strategy it describes, and that summary goes
 * to Claude with the chat's chosen model as a build request.
 */
import { useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { Modal, Spinner, openModal } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { buildPrompt, captionText, looksLikeCaptions, wordCount } from '../../../shared/transcript';

function TranscriptDialog({ model, onClose, onPrompt }: { model: string; onClose: () => void; onPrompt: (prompt: string) => void }) {
  const [text, setText] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  const clean = looksLikeCaptions(text) ? captionText(text) : text.trim();
  const words = wordCount(clean);
  const close = () => {
    closed.current = true;
    onClose();
  };
  const go = async () => {
    if (busy || words < 40) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.call<{ summary: string; truncated: boolean }>('ai:summarizeTranscript', clean, notes);
      if (closed.current) return;
      onPrompt(buildPrompt(r.summary + (r.truncated ? '\n\n(The transcript was cut to its first 600,000 characters.)' : ''), { source, words, notes }));
      close();
    } catch (e) {
      if (!closed.current) setErr(errorMessage(e).replace(/^Validation: /, ''));
    } finally {
      if (!closed.current) setBusy(false);
    }
  };
  const load = (f: File | undefined) => {
    if (!f) return;
    void f.text().then((t) => {
      setText(/\.(srt|vtt|sbv)$/i.test(f.name) || looksLikeCaptions(t) ? captionText(t) : t);
      setSource(f.name);
    });
  };
  return (
    <Modal
      title="Strategy from a transcript"
      icon="spark"
      width={640}
      onClose={close}
      footer={
        <>
          <span className="faint small tr-flow">Sonnet 5.5 (low effort) summarizes · {model} builds</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || words < 40} onClick={() => void go()}>
            {busy ? (
              <>
                <Spinner size={11} /> Sonnet is reading…
              </>
            ) : (
              'Summarize & build'
            )}
          </button>
        </>
      }
    >
      <div className="tr-dialog">
        <div className="faint small">
          Paste the transcript of a trading video, podcast or course, or load a .txt, .srt or .vtt file. Timestamps and caption numbering are removed. Sonnet writes down the strategy it describes (entries, exits, indicators, risk); that summary starts a new chat with {model}, which builds and backtests it.
        </div>
        <textarea
          className="input tr-text"
          placeholder="Paste the transcript here…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSource(null);
          }}
          autoFocus
        />
        <div className="row tr-meta">
          <button className="btn small ghost" onClick={() => file.current?.click()}>
            <Icon name="upload" size={12} /> Load a file…
          </button>
          <input ref={file} type="file" accept=".txt,.srt,.vtt,.sbv,.md,text/plain" hidden onChange={(e) => load(e.target.files?.[0])} />
          <span className="faint small">
            {words.toLocaleString('en-US')} words{source ? ` · ${source}` : ''}
            {words > 0 && words < 40 ? ' · too short for a strategy' : ''}
          </span>
        </div>
        <input className="input" placeholder="Notes for Claude (optional): e.g. BTC 4h, long only, as a Pine strategy" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {err && <div className="warn-text small">{err}</div>}
      </div>
    </Modal>
  );
}

export function openTranscriptDialog(model: string, onPrompt: (prompt: string) => void): void {
  openModal('ai-transcript', (close) => <TranscriptDialog model={model} onClose={close} onPrompt={onPrompt} />);
}
