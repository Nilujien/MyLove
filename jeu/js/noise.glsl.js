// Bruit de valeur 2D et fbm partagés par les shaders.
export const NOISE_GLSL = /* glsl */ `
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
// Variante à 3 octaves, pour les détails peu visibles (moins coûteuse).
float fbm3(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
// Bruit de valeur avec ses dérivées analytiques : (valeur, d/dx, d/dy), pour le même coût.
vec3 vnoised(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y,
              du * vec2(b - a + k * u.y, c - a + k * u.x));
}
// fbm avec dérivées ; « damp » atténue la pente des octaves fines (lissage, comme une différence finie).
vec3 fbmd(vec2 p, float damp) {
  vec3 v = vec3(0.0);
  float a = 0.5, s = 1.0;
  for (int i = 0; i < 4; i++) {
    vec3 n = vnoised(p);
    v += a * vec3(n.x, n.yz * s);
    p = p * 2.03 + 17.1; a *= 0.5; s *= 2.03 * damp;
  }
  return v;
}
`;
