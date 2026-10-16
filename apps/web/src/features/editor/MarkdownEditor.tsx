/**
 * Markdown editor surface built on CodeMirror 6.
 *
 * M0 scope: mount a real CM6 editor with markdown language support and keep
 * its document in Redux so the shell already has a single place to read the
 * current text. Yjs binding (`yCollab`) and the AI diff preview are M1/M4 and
 * intentionally not wired here.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

const WELCOME_DOC = `# InsightHub

团队知识库文档与智能助手平台。

- M0 Bootstrap: 编辑器、WebSocket 通道、共享 Contract 已打通
- M1: Yjs CRDT 协作 + IndexedDB 离线持久化

在右侧面板可以看到 WebSocket 与 /health 的实时状态。
`;

interface MarkdownEditorProps {
  /** Fired on every document change with the full text. */
  onChange?: (value: string) => void;
  initialValue?: string;
}

export function MarkdownEditor({ onChange, initialValue = WELCOME_DOC }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        EditorView.theme({ '&': { fontSize: '14px' }, '.cm-content': { minHeight: '320px' } }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    return () => view.destroy();
  }, [initialValue]);

  return <div className="markdown-editor" ref={hostRef} data-testid="markdown-editor" />;
}
