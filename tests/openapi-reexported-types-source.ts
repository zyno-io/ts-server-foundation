export type OpenApiReexportedStrategy = 'alpha' | 'beta' | 'gamma';
export type OpenApiReexportedOption = 'optionA' | 'optionB' | 'optionC';

interface OpenApiReexportedBindingNodeBase {
    id: string;
    type: 'timeCondition';
    matchNext: string;
    noMatchNext: string;
}

export type OpenApiReexportedBindingNode = OpenApiReexportedBindingNodeBase &
    (
        | {
              timeConditionId: string;
              locationId?: never;
          }
        | {
              locationId: string;
              timeConditionId?: never;
          }
    );

export type OpenApiReexportedRule =
    | {
          indexes: number[];
          startValue: string;
          endValue: string;
          exclude?: boolean;
      }
    | {
          keys: string[];
          startValue: string;
          endValue: string;
          exclude?: boolean;
      };

export interface OpenApiReexportedAlphaConfig {
    type: 'alpha';
    alphaId: string;
}

export interface OpenApiReexportedBetaConfig {
    type: 'beta';
    rootKey: string;
}

export interface OpenApiReexportedGammaConfig {
    type: 'gamma';
    endpoint: string;
}

export type OpenApiReexportedSourceConfig = OpenApiReexportedAlphaConfig | OpenApiReexportedBetaConfig | OpenApiReexportedGammaConfig;

export type OpenApiReexportedStep =
    | {
          type: 'terminal';
          timeout: number;
      }
    | {
          type: 'branch';
          options: Record<string, string>;
      };
