/**
 * GLSL sources.
 *
 * Lighting is one directional key light with a hemispheric ambient term. That
 * is enough to read shape and, importantly, keeps the tile grid legible from
 * the driver-station camera, where judging distance to the far wall is the
 * whole skill being practised.
 * @module
 */

export const LIT_VERTEX = `#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in vec2 aUv;

uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;

out vec3 vNormal;
out vec2 vUv;
out vec3 vWorld;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMatrix * aNormal);
  vUv = aUv;
  gl_Position = uProjection * uView * world;
}
`;

export const LIT_FRAGMENT = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec2 vUv;
in vec3 vWorld;

uniform vec4 uColor;
uniform sampler2D uTexture;
uniform float uUseTexture;
uniform vec3 uLightDir;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uEmissive;

out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  float key = max(dot(n, normalize(uLightDir)), 0.0);

  // Hemispheric ambient: sky colour from above, bounce colour from below.
  // Cheap, and it keeps downward-facing surfaces from going pure black.
  float hemi = n.z * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi);

  vec4 tex = mix(vec4(1.0), texture(uTexture, vUv), uUseTexture);
  vec3 base = uColor.rgb * tex.rgb;
  vec3 lit = base * (ambient + key * 0.75);
  outColor = vec4(mix(lit, base, uEmissive), uColor.a * tex.a);
}
`;

export const LINE_VERTEX = `#version 300 es
precision highp float;

in vec3 aPosition;
in vec4 aColor;

uniform mat4 uProjection;
uniform mat4 uView;

out vec4 vColor;

void main() {
  vColor = aColor;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

export const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }
`;
