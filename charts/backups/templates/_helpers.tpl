{{- define "backups.labels" -}}
app.kubernetes.io/name: backups
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* (dict "ctx" . "component" "garage") */}}
{{- define "backups.selectorLabels" -}}
app.kubernetes.io/name: backups
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "backups.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-credentials" .Release.Name) -}}
{{- end -}}

{{/* In-cluster S3 endpoint the backup jobs upload to. */}}
{{- define "backups.s3Endpoint" -}}
http://garage.{{ .Release.Namespace }}.svc.cluster.local:3900
{{- end -}}

{{/* Storage capacity announced to Garage's layout, in bytes, from storage.size (Gi only). */}}
{{- define "backups.capacityBytes" -}}
{{- mul (trimSuffix "Gi" .Values.storage.size | int64) 1073741824 -}}
{{- end -}}
