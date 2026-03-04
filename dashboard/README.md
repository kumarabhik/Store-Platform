# Store Platform Dashboard

## Local dev
1. Start the dashboard:
```powershell
npm run dev
```
2. Dashboard runs on `http://127.0.0.1:5173` (or Vite's next free port).

## API connectivity
The UI now tries these API bases in order:
- `VITE_API_BASE` (if set)
- `/api` (Vite proxy in dev)
- `http://127.0.0.1:8080`
- `http://localhost:8080`
- `http://127.0.0.1:8000`
- `http://localhost:8000`

## Minikube + port-forward flow
If the API is inside Kubernetes and you are running dashboard locally, yes, you usually still need port-forward:
```powershell
kubectl -n platform port-forward svc/platform-api 8080:80
```

Then run dashboard on `5173`.

## Optional env vars
- `VITE_API_BASE`: force one API base (example: `http://127.0.0.1:8080`)
- `VITE_API_PROXY_TARGET`: Vite dev proxy target for `/api` (default `http://127.0.0.1:8080`)
