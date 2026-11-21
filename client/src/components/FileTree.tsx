import type { TreeNode } from '../lib/api';

type Props = {
  nodes: TreeNode[];
  activePath: string | null;
  onOpen: (filePath: string) => void;
};

function NodeRow({ node, activePath, onOpen, depth }: { node: TreeNode; activePath: string | null; onOpen: Props['onOpen']; depth: number }) {
  const pad = { paddingLeft: `${8 + depth * 12}px` };

  if (node.type === 'dir') {
    return (
      <li>
        <div className="tree-dir" style={pad}>
          {node.name}
        </div>
        <ul>
          {node.children.map((child) => (
            <NodeRow key={child.path} node={child} activePath={activePath} onOpen={onOpen} depth={depth + 1} />
          ))}
        </ul>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={`tree-file${node.path === activePath ? ' active' : ''}`}
        style={pad}
        disabled={!node.editable}
        title={node.editable ? node.path : `${node.path} (not editable)`}
        onClick={() => onOpen(node.path)}
      >
        {node.name}
      </button>
    </li>
  );
}

export function FileTree({ nodes, activePath, onOpen }: Props) {
  if (nodes.length === 0) return <p className="muted">No files yet.</p>;
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <NodeRow key={node.path} node={node} activePath={activePath} onOpen={onOpen} depth={0} />
      ))}
    </ul>
  );
}
