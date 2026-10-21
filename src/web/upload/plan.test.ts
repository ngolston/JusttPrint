import { describe, expect, it } from 'vitest';
import { defaultModelName, joinFolder, mediaKindOf, modelUploadTarget, stem, targetFolder } from './plan';

const info = { mediaExtensions: { image: ['.png', '.jpg'], video: ['.mp4'], document: ['.pdf'] } };

describe('upload plan', () => {
  it('tells media from model files', () => {
    expect(mediaKindOf('Photo.PNG', info)).toBe('image');
    expect(mediaKindOf('Guide.pdf', info)).toBe('document');
    expect(mediaKindOf('Benchy.stl', info)).toBeNull();
    expect(mediaKindOf('Photo.png', null)).toBeNull();
  });

  it('names the model after the first model file', () => {
    expect(defaultModelName(['cover.png', 'Robot Arm.3mf', 'leg.stl'], info)).toBe('Robot Arm');
    expect(defaultModelName(['cover.png'], info)).toBe('cover');
    expect(stem('a.b.stl')).toBe('a.b');
  });

  it('puts media in their subfolders', () => {
    expect(targetFolder('/lib/Robot', 'a.png', info)).toBe('/lib/Robot/image');
    expect(targetFolder('/lib/Robot/', 'clip.mp4', info)).toBe('/lib/Robot/video');
    expect(targetFolder('/lib/Robot', 'part.stl', info)).toBe('/lib/Robot');
    expect(joinFolder('C:\\lib\\Robot', 'document')).toBe('C:\\lib\\Robot\\document');
  });

  it("sorts a model page's upload: media to their subfolders, model files beside the model, the rest into other/", () => {
    const withModels = { ...info, extensions: ['.stl', '.3mf', '.zip'] };
    expect(modelUploadTarget('/lib/Robot', 'a.JPG', withModels)).toEqual({ folder: '/lib/Robot/image', kind: 'image' });
    expect(modelUploadTarget('/lib/Robot', 'Guide.pdf', withModels)).toEqual({ folder: '/lib/Robot/document', kind: 'document' });
    expect(modelUploadTarget('/lib/Robot', 'arm v2.3mf', withModels)).toEqual({ folder: '/lib/Robot', kind: 'model' });
    expect(modelUploadTarget('/lib/Robot', 'Robot.step', withModels)).toEqual({ folder: '/lib/Robot/other', kind: 'other' });
    expect(modelUploadTarget('/lib/Robot', 'README', withModels)).toEqual({ folder: '/lib/Robot/other', kind: 'other' });
  });
});
