const EMOJIS = [
  '📄', '📝', '📒', '📚', '🗂️', '📌', '⭐', '💡', '🧠', '🤖',
  '💬', '🧪', '🔬', '⚙️', '🛠️', '💻', '🖥️', '🌐', '🔌', '🐧',
  '🐍', '☕', '🦀', '📦', '🚀', '🔥', '✅', '❗', '❓', '🎯',
  '🏠', '🔒', '🔑', '☁️', '🗄️', '📊', '📈', '🧮', '🎨', '🎵',
  '📷', '🎮', '🏷️', '📅', '⏰', '💰', '🛒', '✈️', '🍕', '❤️',
];

export default function EmojiPicker({ onPick, onClose }) {
  return (
    <div className="emoji-picker" onMouseLeave={onClose}>
      <div className="emoji-grid">
        {EMOJIS.map((e) => (
          <button key={e} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
      <button className="emoji-clear" onClick={() => onPick('')}>
        Quitar icono
      </button>
    </div>
  );
}
