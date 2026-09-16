/* Synthetic native-library example: weighted straight-line fit. */
#include <math.h>
#include <stddef.h>

/* All arrays have n elements. out has slope, intercept, chi-square.
   Return 0 only for accepted inputs and a finite, identifiable fit. */
int weighted_fit(size_t n, const double *x, const double *y,
                 const double *sigma, double *out) {
  if (!x || !y || !sigma || !out || n < 3 || n > 100000) return 1;
  double sw = 0.0, sx = 0.0, sy = 0.0;
  for (size_t i = 0; i < n; ++i) {
    if (!isfinite(x[i]) || !isfinite(y[i]) || !isfinite(sigma[i]) ||
        fabs(x[i]) > 1e6 || fabs(y[i]) > 1e6 ||
        sigma[i] < 1e-3 || sigma[i] > 1e3) return 1;
    double w = 1.0 / (sigma[i] * sigma[i]);
    sw += w;
    sx += w * x[i];
    sy += w * y[i];
  }
  double mx = sx / sw, my = sy / sw, sxx = 0.0, sxy = 0.0;
  for (size_t i = 0; i < n; ++i) {
    double w = 1.0 / (sigma[i] * sigma[i]), dx = x[i] - mx;
    sxx += w * dx * dx;
    sxy += w * dx * (y[i] - my);
  }
  if (!(sxx > 1e-12 * sw) || !isfinite(sxx) || !isfinite(sxy)) return 2;
  double slope = sxy / sxx, intercept = my - slope * mx, chi2 = 0.0;
  for (size_t i = 0; i < n; ++i) {
    double residual = (y[i] - (slope * x[i] + intercept)) / sigma[i];
    chi2 += residual * residual;
  }
  if (!isfinite(slope) || !isfinite(intercept) || !isfinite(chi2)) return 2;
  out[0] = slope; out[1] = intercept; out[2] = chi2;
  return 0;
}
