"""
Gráfico de Performance & Size ideal por ano com raio de aceitação por segmento.
Dados lidos do arquivo Dados.xlsx
"""

import matplotlib
matplotlib.use('Agg')
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

# Configuração para usar vírgula como separador decimal
def parse_number(val):
    if pd.isna(val):
        return np.nan
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return np.nan

# Ler dados
xl = pd.ExcelFile('Dados.xlsx')
df_perf = pd.read_excel('Dados.xlsx', sheet_name='Perfomance&Sizeano')
df_rel = pd.read_excel('Dados.xlsx', sheet_name='% Relevância por característica')

# Estruturar dados - a primeira linha contém os headers (Des., Tam.)
# Colunas: Unnamed: 0 (Ano), LOW TECH (Des.), Unnamed: 2 (Tam.), HIGH TECH (Des.), Unnamed: 4 (Tam.)
anos = df_perf.iloc[1:, 0].astype(int).values

# Low Tech (LOW TECH)
low_desempenho = [parse_number(v) for v in df_perf.iloc[1:, 1]]
low_tamanho = [parse_number(v) for v in df_perf.iloc[1:, 2]]

# High Tech (HIGH TECH)
high_desempenho = [parse_number(v) for v in df_perf.iloc[1:, 3]]
high_tamanho = [parse_number(v) for v in df_perf.iloc[1:, 4]]

# Raio do círculo (fine cut) - Capsim: 2.5 unidades para todos os segmentos
raio = 2.5

# Capsim: centro do círculo vs ideal spot
# Low Tech: ideal = centro do círculo (sem deslocamento)
# High Tech: ideal na borda inferior-direita (+perf, -size)
sq2 = np.sqrt(2)
ideal_offset_low = np.array([0.0, 0.0])       # centro
ideal_offset_high = np.array([1 / sq2, -1 / sq2])  # leading edge

# Criar figura
fig, ax = plt.subplots(figsize=(12, 9))

# Centro dos círculos (Low Tech)
low_center_x = np.array(low_desempenho)
low_center_y = np.array(low_tamanho)
low_ideal_x = low_center_x + raio * ideal_offset_low[0]
low_ideal_y = low_center_y + raio * ideal_offset_low[1]

# Centro dos círculos (High Tech)
high_center_x = np.array(high_desempenho)
high_center_y = np.array(high_tamanho)
high_ideal_x = high_center_x + raio * ideal_offset_high[0]
high_ideal_y = high_center_y + raio * ideal_offset_high[1]

# Plotar pontos IDEAIS por ano - Low Tech (diamantes)
for i, ano in enumerate(anos):
    ax.scatter(low_ideal_x[i], low_ideal_y[i], c='#2563eb', s=80, zorder=5, marker='D',
               edgecolors='white', linewidths=1.5)
    ax.annotate(str(ano), (low_ideal_x[i], low_ideal_y[i]),
                xytext=(6, 6), textcoords='offset points', fontsize=9, color='#1e40af', fontweight='bold')

# Plotar pontos IDEAIS por ano - High Tech (diamantes)
for i, ano in enumerate(anos):
    ax.scatter(high_ideal_x[i], high_ideal_y[i], c='#dc2626', s=80, zorder=5, marker='D',
               edgecolors='white', linewidths=1.5)
    ax.annotate(str(ano), (high_ideal_x[i], high_ideal_y[i]),
                xytext=(6, 6), textcoords='offset points', fontsize=9, color='#991b1b', fontweight='bold')

# Desenhar círculos centrados nos dados (centro ≠ ideal)
theta = np.linspace(0, 2*np.pi, 100)
for i in range(len(anos)):
    x_circle = low_center_x[i] + raio * np.cos(theta)
    y_circle = low_center_y[i] + raio * np.sin(theta)
    ax.plot(x_circle, y_circle, color='#2563eb', alpha=0.25, linestyle='--', linewidth=1.5)

for i in range(len(anos)):
    x_circle = high_center_x[i] + raio * np.cos(theta)
    y_circle = high_center_y[i] + raio * np.sin(theta)
    ax.plot(x_circle, y_circle, color='#dc2626', alpha=0.25, linestyle='--', linewidth=1.5)

# Linhas conectando os pontos IDEAIS ao longo dos anos
ax.plot(low_ideal_x, low_ideal_y, color='#2563eb', alpha=0.6, linewidth=2, label=f'Low Tech (ideal, raio={raio:.2f})')
ax.plot(high_ideal_x, high_ideal_y, color='#dc2626', alpha=0.6, linewidth=2, label=f'High Tech (ideal, raio={raio:.2f})')

# Configurações do gráfico
ax.set_xlabel('Performance (Desempenho)', fontsize=12, fontweight='bold')
ax.set_ylabel('Size (Tamanho)', fontsize=12, fontweight='bold')
ax.set_title('Performance & Size Ideal por Ano\ncom Raio de Aceitação por Segmento', fontsize=14, fontweight='bold', pad=20)
ax.legend(loc='upper left', fontsize=10)
ax.grid(True, alpha=0.3, linestyle='-')
ax.set_aspect('equal')
ax.set_facecolor('#fafafa')
fig.patch.set_facecolor('white')

# Ajustar limites dos eixos para mostrar bem os círculos e ideais
margin = raio + 1
all_x = list(low_center_x) + list(high_center_x) + list(low_ideal_x) + list(high_ideal_x)
all_y = list(low_center_y) + list(high_center_y) + list(low_ideal_y) + list(high_ideal_y)
ax.set_xlim(min(all_x) - margin, max(all_x) + margin)
ax.set_ylim(min(all_y) - margin, max(all_y) + margin)

plt.tight_layout()
plt.savefig('grafico_performance_size.png', dpi=150, bbox_inches='tight', facecolor='white')
print("Gráfico salvo em: grafico_performance_size.png")
plt.close()
