// src/components/ErrorBoundary.tsx
// Root error boundary. Catches JS/React render errors only — a native crash
// (e.g. SIGSEGV in llama.rn) cannot be caught here. Shows the error on screen
// so a tester can screenshot it, and best-effort POSTs it to Railway.

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { API_BASE } from '../constants/api';
import { useStore } from '../store/useStore';

interface Props { children: React.ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      const userId = useStore.getState().userId ?? 'unknown';
      fetch(`${API_BASE}/diag/crash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          kind: 'js_error_boundary',
          message: error?.message ?? String(error),
          stack: (error?.stack ?? '').slice(0, 2000),
          component_stack: (info?.componentStack ?? '').slice(0, 2000),
          ts: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch {}
  }

  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: '#0A1628', justifyContent: 'center', padding: 28 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 18, marginBottom: 12 }}>
            Herald hit a problem and needs to restart.
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 16 }}>
            Please screenshot this screen and send it over — it tells us exactly what happened.
          </Text>
          <ScrollView style={{ maxHeight: 240, marginBottom: 20 }}>
            <Text style={{ color: '#FF9B9B', fontSize: 12 }}>
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </Text>
          </ScrollView>
          <TouchableOpacity
            onPress={() => this.setState({ error: null })}
            style={{ backgroundColor: '#1A9B8A', paddingVertical: 12, borderRadius: 8, alignItems: 'center' }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}
