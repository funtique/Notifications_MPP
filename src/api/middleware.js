export function requireAuth(req, res, next) {
  if (!req.session?.user || !req.session?.accessToken) {
    return res.status(401).json({ error: "Authentication required" });
  }
  return next();
}