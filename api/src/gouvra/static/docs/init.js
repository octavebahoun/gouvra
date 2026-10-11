// Gouvra API reference: Swagger UI served from this instance (no third-party CDN).
window.addEventListener("load", function () {
  window.ui = SwaggerUIBundle({
    url: "/api/v1/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayOperationId: false,
    defaultModelsExpandDepth: 0,
    docExpansion: "list",
    filter: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
  });
});
