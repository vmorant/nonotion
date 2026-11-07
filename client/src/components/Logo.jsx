// Marca de NoNotion: una "N" cuya diagonal es un trazo azul eléctrico (el
// "No"). Mismo dibujo que public/logo.svg (favicon y pantalla de login).
export function LogoMark({ size = 24, className = '' }) {
  return <img src="/logo.svg" width={size} height={size} alt="" className={'brand-mark ' + className} draggable={false} />;
}

export function Wordmark({ className = '' }) {
  return (
    <span className={'brand-word ' + className}>
      <span className="brand-no">No</span>Notion
    </span>
  );
}
