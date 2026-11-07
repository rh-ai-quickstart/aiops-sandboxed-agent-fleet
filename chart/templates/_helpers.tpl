{{- define "nemoclaw.demoNamespace" -}}
{{- .Values.global.demoNamespace | default "demo" -}}
{{- end -}}

{{- define "nemoclaw.labels" -}}
app.kubernetes.io/part-of: nemoclaw
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.global.lab }}{{ if .user }}
lab.nemoclaw.io/user: {{ .user | quote }}
{{- end }}{{ end }}
{{- end -}}
