import { describe, it, expect } from 'vitest';
import {
  NEW_BASE_BRANCH,
  PROJECT_DEFAULT_BRANCH,
  buildBaseBranchMetadata,
  isBaseBranchChoiceValid,
} from '../components/task-form/base-branch-metadata';

const base = {
  newBranchName: '',
  newBranchFrom: PROJECT_DEFAULT_BRANCH,
  projectDefaultBranch: 'main',
  isLocalBranch: (branch: string) => branch === 'develop',
};

describe('buildBaseBranchMetadata', () => {
  it('stores the project default as the branch it stands for', () => {
    expect(buildBaseBranchMetadata({ ...base, baseBranch: PROJECT_DEFAULT_BRANCH })).toEqual({ baseBranch: 'main' });
  });

  it('does not flag the project default picked by its name', () => {
    expect(buildBaseBranchMetadata({ ...base, baseBranch: 'main' })).not.toHaveProperty('baseBranchChosen');
    expect(buildBaseBranchMetadata({ ...base, baseBranch: 'origin/main' })).not.toHaveProperty('baseBranchChosen');
  });

  it('marks a chosen local branch as local', () => {
    expect(buildBaseBranchMetadata({ ...base, baseBranch: 'develop' })).toEqual({
      baseBranch: 'develop',
      baseBranchChosen: true,
      useLocalBranch: true,
    });
    expect(buildBaseBranchMetadata({ ...base, baseBranch: 'origin/release' })).toEqual({ baseBranch: 'origin/release', baseBranchChosen: true });
  });

  it('stores a new branch with the project default as its start by default', () => {
    expect(
      buildBaseBranchMetadata({ ...base, baseBranch: NEW_BASE_BRANCH, newBranchName: '  feature/login ' }),
    ).toEqual({ baseBranch: 'feature/login', baseBranchChosen: true, newBaseBranchFrom: 'main', useLocalBranch: true });
  });

  it('stores the chosen start branch of a new branch', () => {
    expect(
      buildBaseBranchMetadata({ ...base, baseBranch: NEW_BASE_BRANCH, newBranchName: 'hotfix', newBranchFrom: 'develop' }),
    ).toEqual({ baseBranch: 'hotfix', baseBranchChosen: true, newBaseBranchFrom: 'develop', useLocalBranch: true });
  });
});

describe('isBaseBranchChoiceValid', () => {
  const existing = ['main', 'develop'];

  it('accepts any choice but a new branch without more checks', () => {
    expect(isBaseBranchChoiceValid({ ...base, baseBranch: 'develop' }, existing)).toBe(true);
  });

  it('needs a legal, unused name for a new branch', () => {
    expect(isBaseBranchChoiceValid({ ...base, baseBranch: NEW_BASE_BRANCH, newBranchName: '' }, existing)).toBe(false);
    expect(isBaseBranchChoiceValid({ ...base, baseBranch: NEW_BASE_BRANCH, newBranchName: 'a b' }, existing)).toBe(false);
    expect(isBaseBranchChoiceValid({ ...base, baseBranch: NEW_BASE_BRANCH, newBranchName: 'develop' }, existing)).toBe(false);
    expect(isBaseBranchChoiceValid({ ...base, baseBranch: NEW_BASE_BRANCH, newBranchName: 'feature/x' }, existing)).toBe(true);
  });

  it('needs a branch to start from', () => {
    expect(
      isBaseBranchChoiceValid(
        { ...base, projectDefaultBranch: '', baseBranch: NEW_BASE_BRANCH, newBranchName: 'feature/x' },
        existing,
      ),
    ).toBe(false);
  });
});
