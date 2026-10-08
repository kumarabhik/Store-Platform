{{- define "store.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/name: store-woocommerce
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component: (dict "ctx" . "component" "wordpress") */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: store-woocommerce
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "store.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-credentials" (include "store.fullname" .)) -}}
{{- end -}}

{{/*
Reuse a value already stored in the release's Secret, otherwise use the generated default.
Credentials must never change after first install: MariaDB keeps the password it was
initialized with on its volume, so a new random password would lock WordPress out (SYSTEM.md L4).
Args: (dict "ctx" . "key" "mariadb-password" "default" (randAlphaNum 24))
*/}}
{{- define "store.persistentSecret" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace (include "store.secretName" .ctx) -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else -}}
{{- .default -}}
{{- end -}}
{{- end -}}

{{- define "store.dbHost" -}}
{{ include "store.fullname" . }}-mariadb
{{- end -}}

{{/* Environment shared by WordPress and the WP-CLI init job (both read the same wp-config.php). */}}
{{- define "store.wordpressDbEnv" -}}
- name: WORDPRESS_DB_HOST
  value: "{{ include "store.dbHost" . }}:3306"
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: mariadb-password
{{- end -}}

{{- define "store.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 33
runAsGroup: 33
fsGroup: 33
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "store.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- end -}}
