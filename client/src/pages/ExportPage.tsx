import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ProgressBar, Spinner } from '../components/ui';
import { useAppConfig } from '../hooks/useAppConfig';
import { api, describeError, isOutOfCredits } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useAuth } from '../lib/auth';
import { Link } from '../lib/router';
import { renderCost } from '../../../shared/credits.js';
import { formatSubtitles, hasTranslation, sanitizeFileName } from '../shared';
import type { SubtitleFormat, Track } from '../shared';
import type { Project, RenderView } from '../types';

const FORMAT_INFO: Record<SubtitleFormat, { label: string; text: string }> = {
  srt: { label: 'SRT (.srt)', text: 'Numbered cues with comma-separated milliseconds. Accepted by nearly every video player and editor.' },
  vtt: { label: 'WebVTT (.vtt)', text: 'Starts with a WEBVTT header and uses period-separated milliseconds. The standard for HTML5 video.' },
  txt: { label: 'Plain text (.txt)', text: 'Only the subtitle text, one cue per line, with no timestamps.' },
};

export function ExportPage({ id }: { id: string }) {
  const { config } = useAppConfig();
  const { credits, refresh } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<SubtitleFormat>('srt');
  const [track, setTrack] = useState<Track>('original');
  const [fileName, setFileName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [renderTrack, setRenderTrack] = useState<Track>('original');
  const [render, setRender] = useState<RenderView | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { project: p } = await api.getProject(id);
      setProject(p);
      setRender(p.render);
      setFileName((current) => current || sanitizeFileName(p.name, 'subtitles'));
      if ((p.subtitles ?? []).some(hasTranslation)) {
        setTrack('translation');
        setRenderTrack('translation');
      }
    } catch (e) {
      setError(describeError(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the render while it runs.
  const rendering = render?.state === 'running';
  useEffect(() => {
    if (!rendering) return;
    const timer = setInterval(async () => {
      try {
        const { render: r } = await api.getRender(id);
        setRender(r);
        if (r.state !== 'running') void refresh();
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [rendering, id, refresh]);

  const subs = project?.subtitles ?? [];
  const anyTranslation = useMemo(() => subs.some(hasTranslation), [subs]);
  const result = useMemo(() => formatSubtitles(format, subs, { track }), [format, subs, track]);
  const safeName = sanitizeFileName(fileName, 'subtitles');

  function download() {
    setMessage(null);
    if (result.count === 0) {
      setMessage({ kind: 'error', text: 'There are no valid subtitles to export. Add subtitles in the editor first.' });
      return;
    }
    if (fileName.trim() === '') {
      setMessage({ kind: 'error', text: 'Enter a file name.' });
      return;
    }
    const blob = new Blob([result.content], { type: `${result.mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMessage({ kind: 'success', text: `Downloaded ${safeName}.${format} (${result.count} subtitle${result.count === 1 ? '' : 's'}).` });
  }

  async function startRender() {
    setStarting(true);
    setMessage(null);
    try {
      const { render: r } = await api.startRender(id, renderTrack);
      setRender(r);
      void refresh();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
      if (isOutOfCredits(e)) void refresh();
    } finally {
      setStarting(false);
    }
  }

  if (error) {
    return (
      <div className="container page-message">
        <h1>Could not load this project</h1>
        <Alert kind="error">{error}</Alert>
        <Link to="/" className="btn btn-primary">Back to home</Link>
      </div>
    );
  }
  if (!project) return <div className="container page-message"><Spinner label="Loading project…" /></div>;

  const renderInfo = config?.render;
  const canRender = !!renderInfo?.available && result.count > 0 && !!project.media;
  const cost = project.media && config ? renderCost(project.media.duration, config.credits.costs) : null;

  return (
    <div className="container export">
      <div className="page-head">
        <div>
          <h1>Export</h1>
          <p className="muted">{project.name} - {subs.length} saved subtitle{subs.length === 1 ? '' : 's'}</p>
        </div>
        <Link to={`/editor/${id}`} className="btn">← Back to editor</Link>
      </div>

      {message && <Alert kind={message.kind} onClose={() => setMessage(null)}>{message.text}</Alert>}
      {subs.length === 0 && (
        <Alert kind="warning" title="This project has no subtitles yet.">Add or generate subtitles in the editor, save, then come back to export.</Alert>
      )}

      <div className="export-grid">
        <section className="card panel" aria-labelledby="file-heading">
          <h2 id="file-heading">Subtitle file</h2>
          <p className="muted small">Exports use the subtitles last <strong>saved</strong> in the editor.</p>
          <form onSubmit={(e) => { e.preventDefault(); download(); }}>
            <label htmlFor="export-format">Format</label>
            <select id="export-format" value={format} onChange={(e) => setFormat(e.target.value as SubtitleFormat)}>
              {(Object.keys(FORMAT_INFO) as SubtitleFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label}</option>)}
            </select>
            <p className="muted small">{FORMAT_INFO[format].text}</p>

            {anyTranslation && (
              <>
                <label htmlFor="export-track">Text to export</label>
                <select id="export-track" value={track} onChange={(e) => setTrack(e.target.value as Track)}>
                  <option value="original">Original transcript</option>
                  <option value="translation">Translation</option>
                </select>
                {track === 'translation' && result.missingTranslations > 0 && (
                  <p className="field-warn">{result.missingTranslations} subtitle{result.missingTranslations === 1 ? ' has' : 's have'} no translation yet; the original text is used for {result.missingTranslations === 1 ? 'it' : 'them'}.</p>
                )}
              </>
            )}

            <label htmlFor="file-name">File name</label>
            <input id="file-name" value={fileName} maxLength={80} onChange={(e) => { setFileName(e.target.value); setNameTouched(true); }} aria-describedby="file-name-hint" />
            <p id="file-name-hint" className="muted small">Saved as <code>{safeName}.{format}</code>{nameTouched && safeName !== fileName.trim() ? ' (unsafe characters were replaced)' : ''}</p>

            {result.skipped > 0 && <p className="field-warn">{result.skipped} invalid subtitle{result.skipped === 1 ? ' was' : 's were'} left out of the file.</p>}
            <button type="submit" className="btn btn-primary btn-lg" disabled={result.count === 0}>Download {format.toUpperCase()}</button>
          </form>
        </section>

        <section className="card panel" aria-labelledby="preview-heading">
          <h2 id="preview-heading">Preview</h2>
          {result.count === 0 ? (
            <p className="empty">Nothing to preview - there are no subtitles to export.</p>
          ) : (
            <pre className="preview" tabIndex={0} aria-label={`${format.toUpperCase()} preview`}>{result.content}</pre>
          )}
        </section>
      </div>

      <section className="card panel render-panel" aria-labelledby="render-heading">
        <h2 id="render-heading">Video with burned-in subtitles</h2>
        <p className="muted small">
          This is different from a subtitle file: the text is permanently drawn onto the picture using the style you chose in the editor, and cannot be turned off or changed later. It is processed on the server and can take a while for long videos.
        </p>
        {!renderInfo?.available ? (
          <Alert kind="warning" title="Not available on this server.">{renderInfo?.reason ?? 'Checking…'}</Alert>
        ) : (
          <>
            {anyTranslation && (
              <div className="render-track">
                <label htmlFor="render-track">Text to burn in</label>
                <select id="render-track" value={renderTrack} onChange={(e) => setRenderTrack(e.target.value as Track)} disabled={rendering}>
                  <option value="original">Original transcript</option>
                  <option value="translation">Translation</option>
                </select>
              </div>
            )}
            <div className="row gap wrap">
              <button type="button" className="btn btn-primary" onClick={() => void startRender()} disabled={!canRender || rendering || starting}>
                {rendering ? 'Rendering…' : render?.state === 'succeeded' ? 'Render again' : 'Start rendering'}{cost !== null && !rendering ? ` (${cost} credit${cost === 1 ? '' : 's'})` : ''}
              </button>
              {render?.state === 'succeeded' && (
                <a className="btn" href={api.renderUrl(id)} download>Download video{render.size ? ` (${formatBytes(render.size)})` : ''}</a>
              )}
            </div>
            {rendering && (
              <div className="progress-block">
                <ProgressBar value={render?.progress ?? 0} label="Rendering progress" />
                <p className="small" role="status">Rendering… {Math.round((render?.progress ?? 0) * 100)}%</p>
              </div>
            )}
            {render?.state === 'failed' && <Alert kind="error" title="Rendering failed.">{render.error ?? 'Unknown error.'}</Alert>}
            {render?.state === 'expired' && <Alert kind="info">The previous render was deleted after {renderInfo.retentionHours} hours. Start a new one.</Alert>}
            {render?.state === 'succeeded' && <p className="muted small">Rendered videos are kept for {renderInfo.retentionHours} hours, then deleted automatically.</p>}
            <p className="muted small">Rendering uses the subtitles and style saved in the editor. {cost !== null && <>It costs {cost} credit{cost === 1 ? '' : 's'}{credits ? ` (you have ${credits.total})` : ''}, refunded automatically if it fails. SRT / VTT / TXT files are always free.</>}</p>
            {credits && cost !== null && credits.total < cost && <Alert kind="warning">You do not have enough credits. <Link to="/billing">Get more credits</Link></Alert>}
          </>
        )}
      </section>

      <div className="row gap">
        <Link to={`/editor/${id}`} className="btn">← Return to editor</Link>
        <Link to="/" className="btn">Home</Link>
      </div>
    </div>
  );
}
