"""
Gera dados para o gráfico de densidade a partir de Dados.xlsx.
Execute para atualizar dados_densidade.json quando Dados.xlsx mudar.
"""

import json
import pandas as pd
import numpy as np


def parse_number(val):
    if pd.isna(val):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def main():
    df_perf = pd.read_excel('Dados.xlsx', sheet_name='Perfomance&Sizeano')
    df_rel = pd.read_excel('Dados.xlsx', sheet_name='% Relevância por característica')
    df_tx = pd.read_excel('Dados.xlsx', sheet_name='Tx de Crescimento do Segmento')

    anos = df_perf.iloc[1:, 0].astype(int).values.tolist()
    low_perf = [parse_number(v) for v in df_perf.iloc[1:, 1]]
    low_size = [parse_number(v) for v in df_perf.iloc[1:, 2]]
    high_perf = [parse_number(v) for v in df_perf.iloc[1:, 3]]
    high_size = [parse_number(v) for v in df_perf.iloc[1:, 4]]

    sq2 = np.sqrt(2)
    ideal_offset_low = [0.0, 0.0]
    ideal_offset_high = [1 / sq2, -1 / sq2]

    market_low = df_tx.iloc[0, 1:10].astype(float).tolist()
    market_high = df_tx.iloc[1, 1:10].astype(float).tolist()

    rel_row = df_rel[df_rel['Critérios'].astype(str).str.contains('Posição', na=False)]
    if len(rel_row) >= 1:
        rel_low = float(rel_row.iloc[0].iloc[2]) if pd.notna(rel_row.iloc[0].iloc[2]) else 0.09
        rel_high = float(rel_row.iloc[0].iloc[4]) if pd.notna(rel_row.iloc[0].iloc[4]) else 0.33
    else:
        rel_low, rel_high = 0.09, 0.33

    data = {
        "low": {
            "perf": low_perf,
            "size": low_size,
            "idealOffset": ideal_offset_low,
            "relevance": rel_low,
            "marketSize": market_low,
            "color": "#2563eb",
        },
        "high": {
            "perf": high_perf,
            "size": high_size,
            "idealOffset": ideal_offset_high,
            "relevance": rel_high,
            "marketSize": market_high,
            "color": "#dc2626",
        },
        "constants": {"fineCut": 2.5, "roughCut": 4.0},
    }

    with open("dados_densidade.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print("Gerado: dados_densidade.json")


if __name__ == "__main__":
    main()
