import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { Banner, PrimaryButton } from '../src/components/ui';
import { loadExportModel } from '../src/export/load';
import { buildExportHtml } from '../src/export/print';
import { buildExportXlsx } from '../src/export/xlsx';
import { plural, type ExportModel } from '../src/export/model';
import { colors, fontSize, spacing } from '../src/theme';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export default function ExportScreen() {
  const insets = useSafeAreaInsets();
  const [model, setModel] = useState<ExportModel | null>(null);
  const [busy, setBusy] = useState<'excel' | 'print' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void (async () => {
        try {
          const next = await loadExportModel();
          if (live) setModel(next);
        } catch (e) {
          if (live) setError(messageOf(e));
        }
      })();
      return () => {
        live = false;
      };
    }, [])
  );

  const families = model?.familyCount ?? 0;
  const eventGroups = model?.groups.filter((group) => group.eventId !== null).length ?? 0;
  const nothingToSend = model !== null && families === 0;

  async function exportExcel() {
    if (!model) return;
    setBusy('excel');
    setError(null);
    try {
      const file = new File(Paths.cache, `${fileName(model)}.xlsx`);
      file.create({ overwrite: true });
      file.write(buildExportXlsx(model));

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('This phone has nothing set up to share a file with.');
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: XLSX_MIME,
        UTI: 'org.openxmlformats.spreadsheetml.sheet',
        dialogTitle: 'Wedding family list',
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function printSheet() {
    if (!model) return;
    setBusy('print');
    setError(null);
    try {
      await Print.printAsync({ html: buildExportHtml(model) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: spacing.xxl + insets.bottom }]}
    >
      <Stack.Screen options={{ title: 'Export' }} />

      {error ? <Banner tone="error" title="Could not prepare the export" body={error} /> : null}

      {model === null ? (
        <Text style={styles.lead}>Reading the list…</Text>
      ) : (
        <Text style={styles.lead}>
          {plural(families, 'family', 'families')} · {plural(eventGroups, 'event', 'events')}
        </Text>
      )}

      {nothingToSend ? <Banner tone="info" title="Nothing to export yet" /> : null}

      <View style={styles.actions}>
        <PrimaryButton
          label="Excel sheet (.xlsx)"
          onPress={exportExcel}
          disabled={families === 0 || model === null || busy !== null}
          busy={busy === 'excel'}
        />
        <PrimaryButton
          label="Print (A4)"
          onPress={printSheet}
          disabled={families === 0 || model === null || busy !== null}
          busy={busy === 'print'}
        />
      </View>
    </ScrollView>
  );
}

function fileName(model: ExportModel): string {
  return `wedding-families-${model.generatedAt.slice(0, 10)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  lead: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.primary,
    marginBottom: spacing.lg,
  },

  actions: { gap: spacing.md },
});
