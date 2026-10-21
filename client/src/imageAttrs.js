// Atributos extra de las imágenes: ancho (porcentaje del ancho de la página) y
// alineación. Fábrica sin imports para compartirla con el servidor (que
// convierte a Markdown y debe conservar estos atributos al editar).

export const IMAGE_ALIGNS = ['left', 'center', 'right'];

export function withImageAttrs(Image) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        width: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-width') || null,
          renderHTML: (attrs) => (attrs.width ? { 'data-width': attrs.width, style: `width: ${attrs.width}` } : {}),
        },
        align: {
          default: 'center',
          parseHTML: (el) => (IMAGE_ALIGNS.includes(el.getAttribute('data-align')) ? el.getAttribute('data-align') : 'center'),
          renderHTML: (attrs) => ({ 'data-align': attrs.align || 'center' }),
        },
        // Subida en curso: la imagen se ve al instante y el src llega al terminar
        uploadId: { default: null, rendered: false },
      };
    },
  });
}
